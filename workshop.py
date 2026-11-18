"""Run the workshop prototype and candidate map previews on loopback."""

import argparse
from contextlib import closing, contextmanager
from dataclasses import asdict
import hashlib
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import re
import sqlite3
import sys
from tempfile import NamedTemporaryFile
from threading import BoundedSemaphore
from time import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
import webbrowser
from zipfile import BadZipFile, ZipFile
from zlib import error as InflateError

from serve import MAP_FILES, MapHandler, ROOT
from submission import CHANGES_LIMIT, IMAGE_PATH, Invalid, ZIP_LIMIT, inspect_package
from workshop_auth import DemoIdentityProvider, Sessions, landing, session_cookie, session_token


PREFIX = "/api/workshop/"
PACKAGE_ROUTE = re.compile(r"packages/([a-f0-9]{32})(?:/(.*))?$")
STATUSES = {"approved", "changes_requested", "rejected"}
PAGES = {
    "/workshop/login": "login.html",
    "/workshop/": "submit.html",
    "/workshop/account": "account.html",
    "/workshop/review": "review.html",
    "/workshop/workshop.css": "workshop.css",
    "/workshop/workshop.js": "workshop.js",
    "/workshop/tutorial.js": "tutorial.js",
    "/workshop/campus.png": "campus.png",
    "/workshop/game-display.woff2": "game-display.woff2",
}
PAGE_ROLES = {"/workshop/": "player", "/workshop/account": "player", "/workshop/review": "developer"}
UPLOADS = BoundedSemaphore(2)


class WorkflowError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


SUGGESTION_COUNT = "(SELECT COUNT(*) FROM review_suggestions WHERE submission_id = submissions.id)"
IS_LATEST = "NOT EXISTS (SELECT 1 FROM submissions newer WHERE newer.revision_of = submissions.id)"
SUMMARY = ("id, created_at, status, place, report, owner_id, owner_name, ticket_id, revision_no, "
           "claim_id, claim_name, claimed_at, completed_at, completer_name, completion_note, "
           "withdrawn_at, withdrawal_note, blocker_reason, blocker_at, blocker_name, "
           "blocker_resolved_at, blocker_resolved_name")


class Store:
    def __init__(self, folder):
        folder.mkdir(parents=True, exist_ok=True)
        self.folder = folder
        self.database = folder / "submissions.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("BEGIN IMMEDIATE")
            fields = {column["name"] for column in db.execute("PRAGMA table_info(submissions)")}
            legacy = bool(fields) and "owner_id" not in fields
            if legacy:
                db.execute("ALTER TABLE decisions RENAME TO legacy_decisions")
                db.execute("ALTER TABLE submissions RENAME TO legacy_submissions")
            db.execute("""
                CREATE TABLE IF NOT EXISTS submissions (
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
                    score INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                    place TEXT NOT NULL, report TEXT NOT NULL, package BLOB NOT NULL,
                    owner_id TEXT, owner_name TEXT, UNIQUE (owner_id, digest)
                )
            """)
            db.execute("""
                CREATE TABLE IF NOT EXISTS decisions (
                    submission_id TEXT NOT NULL REFERENCES submissions(id), at INTEGER NOT NULL,
                    status TEXT NOT NULL, note TEXT NOT NULL, reviewer_id TEXT, reviewer_name TEXT
                )
            """)
            if legacy:
                db.execute("""
                    INSERT INTO submissions (id, digest, created_at, score, status, place, report, package)
                    SELECT id, digest, created_at, score, status, place, report, package
                    FROM legacy_submissions ORDER BY rowid
                """)
                db.execute("""
                    INSERT INTO decisions (submission_id, at, status, note)
                    SELECT submission_id, at, status, note FROM legacy_decisions ORDER BY rowid
                """)
                db.execute("DROP TABLE legacy_decisions")
                db.execute("DROP TABLE legacy_submissions")
            db.execute("CREATE INDEX IF NOT EXISTS decisions_by_submission ON decisions(submission_id)")
            db.execute("""
                CREATE TABLE IF NOT EXISTS review_suggestions (
                    id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id),
                    at INTEGER NOT NULL, recommendation TEXT NOT NULL, note TEXT NOT NULL
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS suggestions_by_submission ON review_suggestions(submission_id)")
            fields = {column["name"] for column in db.execute("PRAGMA table_info(submissions)")}
            for name, definition in (
                ("ticket_id", "TEXT"), ("revision_no", "INTEGER NOT NULL DEFAULT 1"),
                ("revision_of", "TEXT REFERENCES submissions(id)"), ("claim_id", "TEXT"),
                ("claim_name", "TEXT"), ("claimed_at", "INTEGER"),
                ("completed_at", "INTEGER"), ("completer_id", "TEXT"), ("completer_name", "TEXT"),
                ("completion_note", "TEXT"),
                ("withdrawn_at", "INTEGER"), ("withdrawal_note", "TEXT"),
                ("blocker_reason", "TEXT"), ("blocker_at", "INTEGER"), ("blocker_name", "TEXT"),
                ("blocker_resolved_at", "INTEGER"), ("blocker_resolved_name", "TEXT"),
            ):
                if name not in fields:
                    db.execute(f"ALTER TABLE submissions ADD COLUMN {name} {definition}")
            db.execute("UPDATE submissions SET ticket_id = id WHERE ticket_id IS NULL")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS submission_successor ON submissions(revision_of)")
            db.execute("CREATE INDEX IF NOT EXISTS submission_ticket ON submissions(ticket_id, revision_no)")

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            yield db

    def add(self, package, place, report, owner, previous_id=None):
        digest = hashlib.sha256(package).hexdigest()
        ident = uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = self.revision_target(db, previous_id, owner) if previous_id else None
            duplicate = db.execute(f"""
                SELECT {SUMMARY}, revision_of, {SUGGESTION_COUNT} AS suggestion_count
                FROM submissions WHERE owner_id = ? AND digest = ?
            """, (owner.id, digest)).fetchone()
            if duplicate is not None:
                if previous and duplicate["revision_of"] != previous_id:
                    raise WorkflowError(409, "same_package", "此 ZIP 已提交过，请上传修订后的交付包")
                return summary(duplicate), False
            ticket, revision = ident, 1
            if previous:
                if db.execute("SELECT 1 FROM submissions WHERE revision_of = ?", (previous_id,)).fetchone():
                    raise WorkflowError(409, "revision_exists", "这次退修已有新版，请返回我的投稿")
                if place["id"] != json.loads(previous["place"])["id"]:
                    raise WorkflowError(422, "revision_target", "修订包的地图目标必须与原工单一致")
                ticket, revision = previous["ticket_id"], previous["revision_no"] + 1
            db.execute("""
                INSERT INTO submissions (id, digest, created_at, score, place, report, package, owner_id, owner_name,
                                         ticket_id, revision_no, revision_of)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (ident, digest, int(time() * 1000), report["reviewScore"],
                      json.dumps(place), json.dumps(report), package, owner.id, owner.name, ticket, revision, previous_id))
            row = db.execute(f"SELECT {SUMMARY}, 0 AS suggestion_count FROM submissions WHERE id = ?", (ident,)).fetchone()
            return summary(row), True

    @staticmethod
    def revision_target(db, ident, owner):
        row = db.execute("""
            SELECT status, place, ticket_id, revision_no FROM submissions WHERE id = ? AND owner_id = ?
        """, (ident, owner.id)).fetchone()
        if row is None:
            raise WorkflowError(404, "not_found", "找不到自己的退修工单")
        if row["status"] != "changes_requested":
            raise WorkflowError(409, "revision_status", "这份投稿当前未要求修订")
        return row

    def queue(self, status=None, limit=-1, awaiting_agent=False):
        with self.connect() as db:
            return [summary(row) for row in db.execute(f"""
                SELECT {SUMMARY}, {SUGGESTION_COUNT} AS suggestion_count
                FROM submissions WHERE ({IS_LATEST}) AND (? IS NULL OR status = ?)
                    AND (NOT ? OR (status = 'pending' AND {SUGGESTION_COUNT} = 0))
                ORDER BY score DESC, created_at ASC, rowid ASC LIMIT ?
            """, (status, status, awaiting_agent, limit))]

    @staticmethod
    def history(db, ticket):
        return [{
            "id": row["id"], "number": row["revision_no"], "status": row["status"],
            "stage": review_stage(row),
            "version": json.loads(row["place"])["active"], "createdAt": row["created_at"], "note": row["note"],
        } for row in db.execute(f"""
            SELECT id, revision_no, status, place, created_at,
                claim_id, {SUGGESTION_COUNT} AS suggestion_count,
                (SELECT note FROM decisions WHERE submission_id = submissions.id ORDER BY rowid DESC LIMIT 1) AS note
            FROM submissions WHERE ticket_id = ? ORDER BY revision_no DESC
        """, (ticket,))]

    def own(self, owner):
        with self.connect() as db:
            return [{**summary(row), "note": row["note"], "history": self.history(db, row["ticket_id"])}
                    for row in db.execute(f"""
                SELECT {SUMMARY}, {SUGGESTION_COUNT} AS suggestion_count,
                    (SELECT note FROM decisions WHERE submission_id = submissions.id ORDER BY rowid DESC LIMIT 1) AS note
                FROM submissions WHERE owner_id = ? AND ({IS_LATEST})
                ORDER BY created_at DESC, rowid DESC
            """, (owner.id,))]

    def detail(self, ident, identity):
        with self.connect() as db:
            row = db.execute(f"""
                SELECT *, {SUGGESTION_COUNT} AS suggestion_count FROM submissions
                WHERE id = ? AND (owner_id = ? OR ? = 'developer')
            """, (ident, identity.id, identity.role)).fetchone()
            if row is None:
                return None
            item = summary(row)
            item["history"] = self.history(db, item["ticketId"])
            item["digest"] = row["digest"]
            item["decisions"] = [dict(entry) for entry in db.execute("""
                SELECT at, status, note, reviewer_name FROM decisions WHERE submission_id = ? ORDER BY rowid DESC
            """, (ident,))]
            if identity.role == "developer":
                item["reviewSuggestions"] = [dict(entry) for entry in db.execute("""
                    SELECT id, at, recommendation, note FROM review_suggestions
                    WHERE submission_id = ? ORDER BY rowid DESC LIMIT 20
                """, (ident,))]
            return item, row["package"]

    def ticket(self, ident, identity):
        with self.connect() as db:
            row = db.execute(f"""
                SELECT {SUMMARY}, {SUGGESTION_COUNT} AS suggestion_count,
                    (SELECT note FROM decisions WHERE submission_id = submissions.id ORDER BY rowid DESC LIMIT 1) AS note
                FROM submissions WHERE ({IS_LATEST})
                  AND ticket_id = (SELECT ticket_id FROM submissions WHERE id = ? AND (owner_id = ? OR ? = 'developer'))
            """, (ident, identity.id, identity.role)).fetchone()
            return {**summary(row), "note": row["note"]} if row else None

    def recommend(self, ident, recommendation, note):
        if recommendation not in STATUSES or not isinstance(note, str) or not 0 < len(note.strip()) <= 2000:
            raise ValueError("请选择建议结论，并填写 1–2000 字的审稿依据")
        suggestion = {"id": uuid4().hex, "at": int(time() * 1000), "recommendation": recommendation, "note": note.strip()}
        with self.connect() as db:
            result = db.execute("""
                INSERT INTO review_suggestions (id, submission_id, at, recommendation, note)
                SELECT ?, id, ?, ?, ? FROM submissions WHERE id = ? AND status = 'pending'
            """, (suggestion["id"], suggestion["at"], recommendation, suggestion["note"], ident))
            return suggestion if result.rowcount else None

    def decide(self, ident, status, note, reviewer):
        with self.connect() as db:
            updated = db.execute(
                "UPDATE submissions SET status = ? WHERE id = ? AND status = 'pending' AND claim_id = ?",
                (status, ident, reviewer.id)
            )
            if not updated.rowcount:
                return False
            db.execute("INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?)",
                       (ident, int(time() * 1000), status, note, reviewer.id, reviewer.name))
            return True

    def complete(self, ident, note, developer):
        now = int(time() * 1000)
        with self.connect() as db:
            result = db.execute(f"""
                UPDATE submissions SET status = 'completed', completed_at = ?, completer_id = ?,
                    completer_name = ?, completion_note = ?,
                    blocker_resolved_name = CASE WHEN blocker_reason IS NOT NULL AND blocker_resolved_at IS NULL
                        THEN ? ELSE blocker_resolved_name END,
                    blocker_resolved_at = CASE WHEN blocker_reason IS NOT NULL
                        THEN COALESCE(blocker_resolved_at, ?) ELSE NULL END
                WHERE id = ? AND status = 'approved' AND ({IS_LATEST})
            """, (now, developer.id, developer.name, note, developer.name, now, ident))
            return bool(result.rowcount)

    def withdraw(self, ident, note, player):
        now = int(time() * 1000)
        with self.connect() as db:
            result = db.execute(f"""
                UPDATE submissions SET status = 'withdrawn', withdrawn_at = ?, withdrawal_note = ?,
                    blocker_resolved_name = CASE WHEN blocker_reason IS NOT NULL AND blocker_resolved_at IS NULL
                        THEN ? ELSE blocker_resolved_name END,
                    blocker_resolved_at = CASE WHEN blocker_reason IS NOT NULL
                        THEN COALESCE(blocker_resolved_at, ?) ELSE NULL END
                WHERE id = ? AND owner_id = ? AND status IN ('pending', 'changes_requested', 'approved')
                    AND ({IS_LATEST})
            """, (now, note, player.name, now, ident, player.id))
            return bool(result.rowcount)

    def block_porting(self, ident, reason, developer):
        with self.connect() as db:
            result = db.execute(f"""
                UPDATE submissions SET blocker_reason = ?, blocker_at = ?, blocker_name = ?,
                    blocker_resolved_at = NULL, blocker_resolved_name = NULL
                WHERE id = ? AND status = 'approved' AND ({IS_LATEST})
                    AND (blocker_reason IS NULL OR blocker_resolved_at IS NOT NULL)
            """, (reason, int(time() * 1000), developer.name, ident))
            return bool(result.rowcount)

    def unblock_porting(self, ident, developer):
        with self.connect() as db:
            result = db.execute(f"""
                UPDATE submissions SET blocker_resolved_at = ?, blocker_resolved_name = ?
                WHERE id = ? AND status = 'approved' AND ({IS_LATEST})
                    AND blocker_reason IS NOT NULL AND blocker_resolved_at IS NULL
            """, (int(time() * 1000), developer.name, ident))
            return bool(result.rowcount)

    def claim(self, ident, reviewer, release=False):
        with self.connect() as db:
            if release:
                result = db.execute("""
                    UPDATE submissions SET claim_id = NULL, claim_name = NULL, claimed_at = NULL
                    WHERE id = ? AND status = 'pending' AND claim_id = ?
                """, (ident, reviewer.id))
            else:
                result = db.execute("""
                    UPDATE submissions SET claim_id = ?, claim_name = ?, claimed_at = COALESCE(claimed_at, ?)
                    WHERE id = ? AND status = 'pending' AND (claim_id IS NULL OR claim_id = ?)
                        AND EXISTS (SELECT 1 FROM review_suggestions WHERE submission_id = submissions.id)
                """, (reviewer.id, reviewer.name, int(time() * 1000), ident, reviewer.id))
            return bool(result.rowcount)


def review_stage(row):
    status = row["status"]
    if status == "pending":
        return "in_review" if row["claim_id"] else "awaiting_review" if row["suggestion_count"] else "awaiting_agent"
    return status


def summary(row):
    completion = {"at": row["completed_at"], "name": row["completer_name"], "note": row["completion_note"]} if row["completed_at"] is not None else None
    withdrawal = {"at": row["withdrawn_at"], "note": row["withdrawal_note"]} if row["withdrawn_at"] is not None else None
    blocker = {
        "reason": row["blocker_reason"], "at": row["blocker_at"], "name": row["blocker_name"],
        "resolvedAt": row["blocker_resolved_at"], "resolvedBy": row["blocker_resolved_name"],
    } if row["blocker_reason"] is not None else None
    return {"id": row["id"], "createdAt": row["created_at"], "status": row["status"],
            "place": json.loads(row["place"]), "report": json.loads(row["report"]),
            "ticketId": row["ticket_id"], "revisionNumber": row["revision_no"], "stage": review_stage(row),
            "suggestionCount": row["suggestion_count"], "completion": completion,
            "withdrawal": withdrawal, "portingBlock": blocker,
            "claim": {"id": row["claim_id"], "name": row["claim_name"], "at": row["claimed_at"]} if row["claim_id"] else None,
            "owner": {"id": row["owner_id"], "name": row["owner_name"]} if row["owner_id"] else None}


def describe_package(item, archive):
    details = {
        **item,
        "manifest": json.loads(archive.read("manifest.json")),
        "submission": json.loads(archive.read("submission.json")),
        "images": [name for name in archive.namelist() if IMAGE_PATH.fullmatch(name)],
    }
    if item["report"]["evidence"]["changes"]:
        details["changes"] = archive.read("changes.md")[:CHANGES_LIMIT].decode("utf-8-sig")
    return details


class WorkshopHandler(MapHandler):
    asset_directories = MapHandler.asset_directories | {"workshop_ui"}

    def local_hosts(self):
        return {f"{host}:{self.server.server_port}" for host in ("localhost", "127.0.0.1")}

    def response(self, status, body, mime, attachment=None, cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        if attachment:
            self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, value, cookie=None):
        self.response(status, json.dumps(value, ensure_ascii=False).encode(),
                      "application/json; charset=utf-8", cookie=cookie)

    def failure(self, status, code, message):
        self.send_json(status, {"passed": False, "error": {"code": code, "message": message}})

    def redirect(self, path):
        self.send_response(302)
        self.send_header("Location", path)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def identity(self):
        return self.server.sessions.resolve(session_token(self.headers.get("Cookie")))

    def require_identity(self, role=None):
        identity = self.identity()
        if not identity:
            self.failure(401, "signin", "请先登录工坊")
        elif role and identity.role != role:
            self.failure(403, "role", "此账号没有这个操作的权限")
        else:
            return identity
        return None

    def show_page(self, path, query):
        identity = self.identity()
        params = parse_qs(query)
        if path == "/workshop/login":
            if identity:
                package_id = params.get("package", [""])[0]
                self.redirect(landing(identity) + (
                    "?package=" + package_id if identity.role == "developer" and re.fullmatch(r"[a-f0-9]{32}", package_id) else ""
                ))
                return
        elif not identity:
            package_id = params.get("package", [""])[0]
            target = "/workshop/login"
            if path == "/workshop/review" and re.fullmatch(r"[a-f0-9]{32}", package_id):
                target += "?package=" + package_id
            elif path == "/workshop/" and params.get("tutorial") == ["1"]:
                target += "?tutorial=1"
            self.redirect(target)
            return
        elif PAGE_ROLES[path] != identity.role:
            self.redirect("/workshop/account" if identity.role == "player" else landing(identity))
            return
        body = (ROOT / "workshop_ui" / PAGES[path]).read_bytes()
        self.response(200, body, "text/html; charset=utf-8")

    def do_GET(self):
        if self.headers.get("Host") not in self.local_hosts():
            self.failure(403, "host", "请使用本机工坊地址")
            return
        url = urlsplit(self.path)
        path = url.path
        package_route = PACKAGE_ROUTE.fullmatch(path[len(PREFIX):]) if path.startswith(PREFIX) else None
        if path == "/workshop":
            self.redirect("/workshop/")
        elif path == "/workshop/login" or path in PAGE_ROLES:
            self.show_page(path, url.query)
        elif path in PAGES:
            self.path = "/workshop_ui/" + PAGES[path]
            super().do_GET()
        elif path == PREFIX + "auth/options":
            self.send_json(200, self.server.identity_provider.options())
        elif path == PREFIX + "session":
            identity = self.require_identity()
            if identity:
                self.send_json(200, asdict(identity))
        elif path == PREFIX + "guide":
            prompt = (ROOT / "MODEL-SUBMISSION-PROMPT.md").read_text(encoding="utf-8").split("```")
            self.send_json(200, {"prompt": prompt[1].removeprefix("text\n").strip()})
        elif path == PREFIX + "packages":
            if self.require_identity("developer"):
                self.send_json(200, self.server.store.queue())
        elif path == PREFIX + "mcp-config":
            if self.require_identity("developer"):
                self.send_json(200, {"mcpServers": {"nanning-workshop-review": {
                    "command": sys.executable,
                    "args": ["-B", str(ROOT / "workshop_mcp.py"), "--storage", str(self.server.store.folder.resolve()),
                             "--workshop-port", str(self.server.server_port)],
                }}})
        elif path == PREFIX + "my-submissions":
            player = self.require_identity("player")
            if player:
                self.send_json(200, self.server.store.own(player))
        elif package_route:
            identity = self.require_identity()
            if identity:
                self.package_get(package_route[1], package_route[2], parse_qs(url.query), identity)
        elif path in ("/workshop/example.zip", "/workshop/example-revision.zip"):
            filename = "nn14-jianzheng-revision-demo.zip" if path.endswith("example-revision.zip") else "nn14-jianzheng-1.0.0.zip"
            sample = ROOT / "submissions" / filename
            self.response(200, sample.read_bytes(), "application/zip", sample.name)
        elif path == "/" or path[1:] in MAP_FILES or (
            path.startswith(("/data/", "/vendor/", "/city-source/"))
            and all(segment not in ("", ".", "..") and not segment.startswith(".") for segment in path[1:].split("/"))
            and "\\" not in path and "%" not in path
        ):
            super().do_GET()
        else:
            self.failure(404, "not_found", "找不到这个页面")

    def do_HEAD(self):
        # The base handler serves arbitrary workspace paths for HEAD.
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        path = urlsplit(self.path).path
        hosts = self.local_hosts()
        if (self.headers.get("Host") not in hosts or self.headers.get("X-Workshop-Request") != "1"
                or self.headers.get("Origin") not in {f"http://{host}" for host in hosts}):
            self.failure(403, "origin", "请从本机工坊页面提交")
            return
        package_route = PACKAGE_ROUTE.fullmatch(path[len(PREFIX):]) if path.startswith(PREFIX) else None
        if path == PREFIX + "auth/login":
            self.login()
        elif path == PREFIX + "auth/logout":
            self.server.sessions.revoke(session_token(self.headers.get("Cookie")))
            self.send_json(200, {"next": "/workshop/login"}, cookie=session_cookie())
        elif (path == PREFIX + "packages" or package_route and package_route[2] == "revision"
              ) and self.headers.get_content_type() == "application/zip":
            player = self.require_identity("player")
            if not player:
                return
            if not UPLOADS.acquire(blocking=False):
                self.failure(503, "busy", "正在校验其他交付包，请稍后重试")
                return
            try:
                self.upload(player, package_route[1] if package_route else None)
            finally:
                UPLOADS.release()
        elif package_route and package_route[2] == "decision":
            reviewer = self.require_identity("developer")
            if reviewer:
                self.record_decision(package_route[1], reviewer)
        elif package_route and package_route[2] == "complete":
            developer = self.require_identity("developer")
            if developer:
                self.record_completion(package_route[1], developer)
        elif package_route and package_route[2] == "withdraw":
            player = self.require_identity("player")
            if player:
                self.record_withdrawal(package_route[1], player)
        elif package_route and package_route[2] in ("block-porting", "unblock-porting"):
            developer = self.require_identity("developer")
            if developer:
                self.update_porting_block(package_route[1], developer, package_route[2] == "unblock-porting")
        elif package_route and package_route[2] in ("claim", "release"):
            reviewer = self.require_identity("developer")
            if reviewer:
                release = package_route[2] == "release"
                if self.server.store.claim(package_route[1], reviewer, release):
                    self.send_json(200, {"claimed": not release})
                else:
                    self.failure(409, "claim_conflict", "工单状态已变更或由其他审核员认领，请刷新队列")
        else:
            self.failure(400, "request", "请选择一个 ZIP 交付包")

    def length(self, maximum):
        value = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]{1,10}", value) or not 0 < int(value) <= maximum:
            raise Invalid("size", "请求为空或超过尺寸上限")
        return int(value)

    def login(self):
        try:
            data = json.loads(self.rfile.read(self.length(4096)))
            if not isinstance(data, dict):
                raise ValueError
        except (ValueError, RecursionError):
            self.failure(400, "signin", "请选择一个演示账号")
            return
        identity = self.server.identity_provider.authenticate(data)
        if not identity:
            self.failure(401, "demo_account", "找不到此演示账号")
            return
        token = self.server.sessions.issue(identity, session_token(self.headers.get("Cookie")))
        target = landing(identity)
        package_id = data.get("package")
        if identity.role == "player" and data.get("tutorial") is True:
            target += "?tutorial=1"
        elif identity.role == "developer" and isinstance(package_id, str) and re.fullmatch(r"[a-f0-9]{32}", package_id):
            target += "?package=" + package_id
        self.send_json(200, {"account": asdict(identity), "next": target}, cookie=session_cookie(token))

    def upload(self, player, previous_id=None):
        try:
            size = self.length(ZIP_LIMIT)
            with NamedTemporaryFile(dir=self.server.store.folder, suffix=".zip", delete=False) as file:
                temporary = Path(file.name)
                try:
                    remaining = size
                    while remaining:
                        part = self.rfile.read(min(remaining, 1024 * 1024))
                        if not part:
                            raise Invalid("upload", "上传中断，请重新上传")
                        remaining -= len(part)
                        file.write(part)
                    file.close()
                    report, place, _, _ = inspect_package(temporary)
                    receipt, created = self.server.store.add(temporary.read_bytes(), place, report, player, previous_id)
                finally:
                    file.close()
                    temporary.unlink(missing_ok=True)
        except Invalid as error:
            self.failure(422, error.code, str(error))
            return
        except WorkflowError as error:
            self.failure(error.status, error.code, str(error))
            return
        except (BadZipFile, ValueError, RecursionError, RuntimeError, InflateError):
            self.failure(422, "package", "无法读取 ZIP 或模型结构")
            return
        except (OSError, sqlite3.Error):
            self.failure(503, "storage", "保存投稿失败，请稍后重试")
            return
        self.send_json(201 if created else 200, {**receipt, "duplicate": not created})

    def package_get(self, ident, operation, query, identity):
        if operation == "ticket":
            latest = self.server.store.ticket(ident, identity)
            if latest is None:
                self.failure(404, "not_found", "找不到这份工单")
            else:
                self.send_json(200, latest)
            return
        result = self.server.store.detail(ident, identity)
        if result is None:
            self.failure(404, "not_found", "找不到这份投稿")
            return
        item, package = result
        place = item["place"]
        if operation == "download":
            self.response(200, package, "application/zip", f"{place['id']}-{place['active']}.zip")
            return
        with ZipFile(io.BytesIO(package)) as archive:
            if operation is None:
                self.send_json(200, describe_package(item, archive))
                return
            manifest = archive.read("manifest.json")
            if operation == "image":
                image = query.get("name", [""])[0]
                if IMAGE_PATH.fullmatch(image) and image in archive.namelist():
                    mime = "image/png" if image.lower().endswith(".png") else "image/jpeg"
                    try:
                        data = archive.read(image)
                    except (BadZipFile, RuntimeError, InflateError):
                        self.failure(404, "image", "图片无法读取")
                        return
                    self.response(200, data, mime)
                else:
                    self.failure(404, "image", "找不到图片")
            elif operation == "replacements/index.json":
                self.send_json(200, {"schemaVersion": 1, "baseRevision": json.loads(manifest)["baseRevision"],
                                     "targets": [place]})
            elif operation == f"replacements/{place['id']}/{place['active']}/manifest.json":
                self.response(200, manifest, "application/json")
            elif operation == f"replacements/{place['id']}/{place['active']}/model.glb":
                self.response(200, archive.read("model.glb"), "model/gltf-binary")
            else:
                self.failure(404, "not_found", "找不到该交付包资源")

    def record_decision(self, ident, reviewer):
        try:
            data = json.loads(self.rfile.read(self.length(8192)))
            status, note = data.get("status"), data.get("note", "")
            if status not in STATUSES or not isinstance(note, str) or len(note) > 1000:
                raise ValueError
            note = note.strip()
            if status != "approved" and not note:
                self.failure(422, "note", "退修或拒绝时请填写给投稿者的原因")
                return
        except (ValueError, TypeError, AttributeError, RecursionError):
            self.failure(422, "decision", "请选择审核结论并检查说明")
            return
        if not self.server.store.decide(ident, status, note, reviewer):
            self.failure(409, "decision_conflict", "请先认领待复核工单，或刷新队列查看最新状态")
            return
        self.send_json(200, {"status": status})

    def read_note(self):
        data = json.loads(self.rfile.read(self.length(8192)))
        note = data.get("note", "") if isinstance(data, dict) else None
        if not isinstance(note, str) or len(note) > 1000:
            raise ValueError
        return note.strip()

    def record_completion(self, ident, developer):
        try:
            note = self.read_note()
        except (ValueError, RecursionError):
            self.failure(422, "completion_note", "请检查移植说明")
            return
        if not self.server.store.complete(ident, note, developer):
            self.failure(409, "completion_conflict", "请打开已接受、待移植的工单")
            return
        self.send_json(200, {"status": "completed"})

    def record_withdrawal(self, ident, player):
        try:
            note = self.read_note()
        except (ValueError, RecursionError):
            self.failure(422, "withdrawal_note", "请检查撤回说明")
            return
        if not self.server.store.withdraw(ident, note, player):
            self.failure(409, "withdrawal_conflict", "请打开自己的当前工单，确认工单仍可撤回")
            return
        self.send_json(200, {"status": "withdrawn"})

    def update_porting_block(self, ident, developer, clear):
        try:
            note = self.read_note()
            if not clear and not note:
                raise ValueError
        except (ValueError, RecursionError):
            self.failure(422, "blocker_note", "请填写移植阻塞原因")
            return
        store = self.server.store
        updated = store.unblock_porting(ident, developer) if clear else store.block_porting(ident, note, developer)
        if not updated:
            self.failure(409, "blocker_conflict", "工单或阻塞状态已变更，请刷新后重试")
            return
        self.send_json(200, {"blocked": not clear})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--storage", type=Path, default=ROOT / ".workshop")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), WorkshopHandler) as server:
        server.preview_files = {}
        server.store = Store(args.storage)
        server.identity_provider = DemoIdentityProvider()
        server.sessions = Sessions(server.store.connect)
        root = f"http://127.0.0.1:{server.server_port}"
        print(f"Login: {root}/workshop/login\nPlayer: {root}/workshop/account\nReview: {root}/workshop/review", flush=True)
        if args.open:
            webbrowser.open(root + "/workshop/login")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
