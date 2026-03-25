from __future__ import annotations

import http.server
import socketserver
import threading
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


def fetch(path: str) -> tuple[int, str]:
    def handler(*args, **kwargs):  # type: ignore[no-untyped-def]
        return QuietHandler(*args, directory=str(REPO_ROOT), **kwargs)

    with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
        server.allow_reuse_address = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address
            with urllib.request.urlopen(f"http://{host}:{port}{path}") as response:
                return response.status, response.read().decode("utf-8")
        finally:
            server.shutdown()
            thread.join(timeout=5)


def test_static_assets_are_present() -> None:
    assert (REPO_ROOT / "index.html").exists()
    assert (REPO_ROOT / "styles.css").exists()
    assert (REPO_ROOT / "app.js").exists()


def test_home_page_renders_expected_shell() -> None:
    status, body = fetch("/")
    assert status == 200
    assert "OSS Signal" in body
    assert "workspaceNote" in body
    assert "warningPanel" in body
    assert "./app.js" in body


def test_deep_link_route_still_serves_index() -> None:
    status, body = fetch("/?repo=openai/openai-python")
    assert status == 200
    assert "Analyze" in body


def test_static_asset_endpoints_load() -> None:
    status, css_body = fetch("/styles.css")
    assert status == 200
    assert ":root" in css_body

    status, js_body = fetch("/app.js")
    assert status == 200
    assert "loadRepository" in js_body
