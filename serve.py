"""Serve the local map and its assets on the loopback interface."""

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from re import fullmatch
from tempfile import NamedTemporaryFile
from threading import BoundedSemaphore
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import webbrowser


ROOT = Path(__file__).resolve().parent
CITY_RELEASE = "https://assets.nanningol.com/releases/20261116-144800-v082/city/"
CITY_CACHE = ROOT / "data" / "city-source"
CITY_BASE = {"index.json", "terrain.json", "terrain.png"}
CITY_GROUPS = {"tiles", "styles", "roads", "streets", "road-signs", "compounds", "riverfront", "tunnels", "life"}
DOWNLOADS = BoundedSemaphore(6)
MAX_BYTES = 24 * 1024 * 1024
MAP_FILES = {"index.html", "app.js", "map.js", "replacements.js", "street.js", "street-tiles.js",
             "street-materials.js", "landmarks.js", "terrain.js", "style.css", "map-search.js", "map-search.css"}


class MapHandler(SimpleHTTPRequestHandler):
    asset_directories = {"data", "vendor"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        # Serve map assets even when the checkout contains a private database or source files.
        resolved = Path(self.translate_path(self.path)).resolve()
        relative = resolved.relative_to(ROOT) if resolved.is_relative_to(ROOT) else None
        parts = relative.parts if relative is not None else ()
        allowed = resolved == ROOT or (
            bool(parts) and not any(part.startswith(".") for part in parts) and resolved.is_file()
            and (str(relative) in MAP_FILES or parts[0] in self.asset_directories)
            and not any(".sqlite" in part.lower() for part in parts)
        )
        if not allowed:
            self.send_error(404)
            return None
        return super().send_head()

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path in self.server.preview_files:
            content_type, content = self.server.preview_files[url.path]
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        prefix = "/city-source/"
        if not url.path.startswith(prefix):
            return super().do_GET()
        relative = url.path[len(prefix):]
        if relative in CITY_BASE:
            file = ROOT / "data" / relative
        else:
            group, _, filename = relative.partition("/")
            if group not in CITY_GROUPS or not fullmatch(r"[a-zA-Z0-9_-]+\.(?:json|bin(?:\.gz)?)", filename):
                return self.send_error(404)
            file = CITY_CACHE / group / filename
            if not file.is_file():
                try:
                    self.download_city(relative, file)
                except HTTPError as error:
                    return self.send_error(error.code)
                except (OSError, URLError, ValueError):
                    return self.send_error(503, "City asset is temporarily unavailable")
        self.path = "/" + file.relative_to(ROOT).as_posix()
        return super().do_GET()

    def download_city(self, relative, file):
        with DOWNLOADS:
            if file.is_file():
                return
            request = Request(CITY_RELEASE + relative, headers={"User-Agent": "Nanning-local-map/1.0"})
            with urlopen(request, timeout=12) as response:
                declared = int(response.headers.get("Content-Length", 0))
                if declared > MAX_BYTES:
                    raise ValueError("City asset exceeds size limit")
                content = response.read(MAX_BYTES + 1)
            if len(content) > MAX_BYTES or (declared and len(content) != declared):
                raise ValueError("City asset length is invalid")
            file.parent.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(dir=file.parent, delete=False) as temporary:
                temporary.write(content)
            Path(temporary.name).replace(file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=8788, type=int)
    parser.add_argument("--open", action="store_true", help="Open the map in the default browser.")
    parser.add_argument("--submission", type=Path, help="Preview a workshop ZIP without editing release files.")
    args = parser.parse_args()
    files = {}
    target = None
    if args.submission:
        from submission import inspect_package
        from zipfile import BadZipFile

        try:
            report, place, manifest, model = inspect_package(args.submission)
            target = place["id"]
            release = json.loads((ROOT / "data/replacements/index.json").read_text(encoding="utf-8"))
            release["targets"] = [row for row in release["targets"] if row["id"] != target] + [place]
            folder = f"/data/replacements/{target}/{place['active']}/"
            files = {
                "/data/replacements/index.json": ("application/json", json.dumps(release).encode()),
                folder + "manifest.json": ("application/json", manifest),
                folder + "model.glb": ("model/gltf-binary", model),
            }
        except (BadZipFile, OSError, ValueError, RuntimeError, RecursionError) as error:
            parser.error(str(error))
        print(f"Review score: {report['reviewScore']}/{report['maxScore']}")
    with ThreadingHTTPServer(("127.0.0.1", args.port), MapHandler) as server:
        server.preview_files = files
        url = f"http://127.0.0.1:{server.server_port}/"
        print(url, flush=True)
        if target:
            print(f"3D: {url}?view=model&id={target}")
            print(f"Street: {url}?view=street&id={target}", flush=True)
            url += f"?view=model&id={target}"
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
