"""Workshop identity boundary. The demo provider resolves only local sample accounts."""

from dataclasses import asdict, dataclass
import hashlib
from http.cookies import CookieError, SimpleCookie
import re
import secrets
from time import time


COOKIE = "nnol_workshop_session"
SESSION_SECONDS = 12 * 60 * 60


@dataclass(frozen=True)
class Identity:
    id: str
    name: str
    role: str


class DemoIdentityProvider:
    accounts = {account.id: account for account in (
        Identity("demo-player-1", "玩家演示 A", "player"),
        Identity("demo-player-2", "玩家演示 B", "player"),
        Identity("demo-developer", "开发者演示", "developer"),
        Identity("demo-reviewer", "复核员演示", "developer"),
    )}

    def options(self):
        return [asdict(account) for account in self.accounts.values()]

    def authenticate(self, data):
        account = data.get("account")
        return self.accounts.get(account) if isinstance(account, str) else None


def session_token(header):
    try:
        cookie = SimpleCookie(header or "").get(COOKIE)
    except CookieError:
        return None
    if cookie and re.fullmatch(r"[A-Za-z0-9_-]{43}", cookie.value):
        return cookie.value


def token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def session_cookie(token=None):
    value = token or ""
    age = SESSION_SECONDS if token else 0
    return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}"


def landing(identity):
    return "/workshop/review" if identity.role == "developer" else "/workshop/"


class Sessions:
    def __init__(self, connect):
        self.connect = connect
        with connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS workshop_sessions (
                    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
                    account_id TEXT NOT NULL, name TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('player', 'developer'))
                )
            """)

    def issue(self, identity, previous_token=None):
        token = secrets.token_urlsafe(32)
        now = int(time())
        with self.connect() as db:
            db.execute("DELETE FROM workshop_sessions WHERE expires_at <= ?", (now,))
            if previous_token:
                db.execute("DELETE FROM workshop_sessions WHERE token_hash = ?", (token_hash(previous_token),))
            db.execute("INSERT INTO workshop_sessions VALUES (?, ?, ?, ?, ?)",
                       (token_hash(token), now + SESSION_SECONDS, identity.id, identity.name, identity.role))
        return token

    def resolve(self, token):
        if not token:
            return None
        with self.connect() as db:
            row = db.execute("""
                SELECT account_id, name, role FROM workshop_sessions
                WHERE token_hash = ? AND expires_at > ?
            """, (token_hash(token), int(time()))).fetchone()
            return Identity(*row) if row else None

    def revoke(self, token):
        if token:
            with self.connect() as db:
                db.execute("DELETE FROM workshop_sessions WHERE token_hash = ?", (token_hash(token),))
