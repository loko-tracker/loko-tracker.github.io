"""Локальный сервер: отдаёт страницу, проверяет вход, принимает правки лазарета.

Только стандартная библиотека. По умолчанию слушает 127.0.0.1 — то есть
снаружи недоступен вообще. Открыть в сеть можно флагом --host, но тогда
пароль становится единственной защитой, а трафик пойдёт без шифрования,
поэтому сервер об этом честно предупреждает.

    python serve.py                 # только этот компьютер
    python serve.py --port 8800
    python serve.py --host 0.0.0.0  # видно в локальной сети (с предупреждением)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import auth
import injuries as injuries_module

ROOT = Path(__file__).parent
WEB = ROOT / "web"
DATA = ROOT / "data"

# Отдаём строго перечисленные файлы: имя из запроса никогда не попадает
# в путь на диске, поэтому выйти за пределы каталога невозможно.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

MAX_BODY = 256 * 1024
CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "khl-tracker"

# Каталоги, отдаваемые целиком: библиотеки и логотипы клубов.
# Имя файла проверяется по шаблону и ещё раз — по итоговому пути,
# так что «../» и абсолютные пути не пройдут.
ASSET_DIRS = {
    "/vendor/": (WEB / "vendor", {".js": "text/javascript; charset=utf-8",
                                  ".css": "text/css; charset=utf-8",
                                  ".map": "application/json; charset=utf-8"}),
    "/logos/":  (WEB / "logos",  {".png": "image/png",
                                  ".svg": "image/svg+xml",
                                  ".webp": "image/webp"}),
}

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")

lockout = auth.Lockout()


class Handler(BaseHTTPRequestHandler):
    server_version = "khl-tracker"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ служебное

    def log_message(self, fmt, *args):       # тише стандартного логгера
        if self.path.startswith("/login") or self.command == "POST":
            sys.stderr.write(f"  {self.command} {self.path} — {args[1] if len(args) > 1 else ''}\n")

    def _client(self) -> str:
        return self.client_address[0] if self.client_address else "?"

    def _authed(self) -> bool:
        token = auth.read_cookie(self.headers.get("Cookie"))
        return auth.verify_session(token)

    def _send(self, status: int, body: bytes = b"", content_type: str = "text/plain; charset=utf-8",
              extra: list[tuple[str, str]] | None = None) -> None:
        headers = {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        }
        # Set-Cookie может встречаться несколько раз, остальное заголовки
        # перекрывают: иначе Cache-Control уехал бы в ответ дважды.
        repeated = []
        for name, value in extra or ():
            if name.lower() == "set-cookie":
                repeated.append((name, value))
            else:
                headers[name] = value

        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        for name, value in repeated:
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(
            status,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _redirect(self, location: str, extra: list[tuple[str, str]] | None = None) -> None:
        self._send(HTTPStatus.FOUND, b"", "text/plain; charset=utf-8",
                   [("Location", location), *(extra or [])])

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return b""
        if length <= 0 or length > MAX_BODY:
            return b""
        return self.rfile.read(length)

    # ----------------------------------------------------------------- GET

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]

        if path == "/login":
            self._serve_login()
            return

        if not auth.is_configured():
            self._send(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "Вход не настроен. Запусти: python setup_login.py".encode("utf-8"),
            )
            return

        if not self._authed():
            self._redirect("/login")
            return

        if path in STATIC:
            name, content_type = STATIC[path]
            file = WEB / name
            if not file.exists():
                self._send(HTTPStatus.NOT_FOUND, b"no such file")
                return
            self._send(HTTPStatus.OK, file.read_bytes(), content_type)
            return

        if path == "/data.json":
            file = DATA / "site_data.json"
            if not file.exists():
                self._json(HTTPStatus.SERVICE_UNAVAILABLE,
                           {"error": "данных нет — запусти python run.py"})
                return
            self._send(HTTPStatus.OK, file.read_bytes(), "application/json; charset=utf-8")
            return

        if path == "/api/injuries":
            self._json(HTTPStatus.OK, {"injuries": injuries_module.merged()})
            return

        if self._serve_asset(path):
            return

        self._send(HTTPStatus.NOT_FOUND, b"not found")

    def _serve_asset(self, path: str) -> bool:
        """Отдаёт файл из /vendor/ или /logos/, если путь безопасен."""
        for prefix, (directory, types) in ASSET_DIRS.items():
            if not path.startswith(prefix):
                continue
            name = path[len(prefix):]
            if not SAFE_NAME.match(name):
                self._send(HTTPStatus.NOT_FOUND, b"not found")
                return True

            file = (directory / name).resolve()
            # Двойная проверка: даже при странном имени путь обязан
            # остаться внутри разрешённого каталога.
            try:
                file.relative_to(directory.resolve())
            except ValueError:
                self._send(HTTPStatus.NOT_FOUND, b"not found")
                return True

            if not file.is_file():
                self._send(HTTPStatus.NOT_FOUND, b"not found")
                return True

            content_type = types.get(file.suffix.lower())
            if not content_type:
                self._send(HTTPStatus.NOT_FOUND, b"not found")
                return True

            # Библиотеки и логотипы не меняются между обновлениями —
            # пусть браузер держит их в кэше.
            self._send(HTTPStatus.OK, file.read_bytes(), content_type,
                       [("Cache-Control", "public, max-age=86400")])
            return True
        return False

    # ---------------------------------------------------------------- POST

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]

        if path == "/login":
            self._handle_login()
            return

        # Всё остальное — только для вошедших и только со своей страницы.
        if not self._authed():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "нужно войти"})
            return
        if self.headers.get(CSRF_HEADER) != CSRF_VALUE:
            self._json(HTTPStatus.FORBIDDEN, {"error": "запрос не со страницы"})
            return

        if path == "/logout":
            self._redirect("/login", [("Set-Cookie", auth.clear_cookie_header())])
            return

        if path == "/api/injuries":
            self._handle_injuries()
            return

        self._json(HTTPStatus.NOT_FOUND, {"error": "нет такого метода"})

    # --------------------------------------------------------------- вход

    def _serve_login(self, error: str | None = None, status: int = HTTPStatus.OK) -> None:
        file = WEB / "login.html"
        if not file.exists():
            self._send(HTTPStatus.NOT_FOUND, b"login.html missing")
            return
        html = file.read_text(encoding="utf-8")
        if error:
            # Подставляем текст ошибки в заранее заданное место шаблона.
            safe = error.replace("<", "&lt;").replace("&", "&amp;")
            html = html.replace("<!--ERROR-->", f'<p class="error" role="alert">{safe}</p>')
        self._send(status, html.encode("utf-8"), "text/html; charset=utf-8")

    def _handle_login(self) -> None:
        import urllib.parse

        if not auth.is_configured():
            self._serve_login("Вход не настроен: запусти python setup_login.py",
                              HTTPStatus.SERVICE_UNAVAILABLE)
            return

        client = self._client()
        waiting = lockout.locked_for(client)
        if waiting:
            self._serve_login(
                f"Слишком много попыток. Подожди {waiting} с.",
                HTTPStatus.TOO_MANY_REQUESTS,
            )
            return

        fields = urllib.parse.parse_qs(self._read_body().decode("utf-8", "replace"))
        login = (fields.get("login") or [""])[0].strip()
        password = (fields.get("password") or [""])[0]

        try:
            ok = bool(login) and bool(password) and auth.check_password(login, password)
        except auth.AuthNotConfigured:
            self._serve_login("Вход не настроен.", HTTPStatus.SERVICE_UNAVAILABLE)
            return

        if not ok:
            lockout.record_failure(client)
            import time
            time.sleep(auth.FAIL_DELAY)      # ровная задержка на любой отказ
            left = max(0, auth.MAX_FAILS - len(lockout._fails.get(client, [])))
            hint = f" Осталось попыток: {left}." if left else ""
            self._serve_login("Неверный логин или пароль." + hint, HTTPStatus.UNAUTHORIZED)
            return

        lockout.reset(client)
        token, expires = auth.issue_session()
        self._redirect("/", [("Set-Cookie", auth.cookie_header(token, expires))])

    # ------------------------------------------------------------- лазарет

    def _handle_injuries(self) -> None:
        """Перезаписывает ручную часть лазарета. Автоматическую не трогает."""
        try:
            payload = json.loads(self._read_body().decode("utf-8", "replace"))
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "битый JSON"})
            return

        entries = payload.get("manual")
        if not isinstance(entries, list) or len(entries) > 500:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "ожидался список manual"})
            return

        cleaned = []
        for item in entries:
            if not isinstance(item, dict):
                continue
            name = str(item.get("player") or "").strip()[:120]
            if not name:
                continue
            cleaned.append(
                {
                    "player": name,
                    "player_id": item.get("player_id") if isinstance(item.get("player_id"), int) else None,
                    "team": str(item.get("team") or "").strip()[:80],
                    "team_id": item.get("team_id") if isinstance(item.get("team_id"), int) else None,
                    "status": str(item.get("status") or "травма").strip()[:40],
                    "until": str(item.get("until") or "").strip()[:60],
                    "note": str(item.get("note") or "").strip()[:300],
                    "added_at": str(item.get("added_at") or dt.datetime.now().isoformat(timespec="seconds"))[:32],
                }
            )

        data = injuries_module.load()
        data["manual"] = cleaned
        injuries_module.save(data)
        self._json(HTTPStatus.OK, {"ok": True, "injuries": injuries_module.merged(data)})


def run(host: str = "127.0.0.1", port: int = 8777, open_browser: bool = True) -> None:
    if not auth.is_configured():
        print("Вход не настроен. Сначала задай логин и пароль:\n")
        print("    python setup_login.py\n")
        raise SystemExit(1)

    if host not in ("127.0.0.1", "localhost"):
        print()
        print("  ВНИМАНИЕ: сервер будет виден по сети на адресе", host)
        print("  Соединение без шифрования (http), защита — только пароль.")
        print("  Для доступа из интернета так делать не стоит.")
        print()

    server = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{'localhost' if host == '127.0.0.1' else host}:{port}/"

    print(f"Сайт открыт: {url}")
    print("Остановить — закрыть это окно или Ctrl+C\n")

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлен.")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальный сервер трекера КХЛ")
    parser.add_argument("--host", default="127.0.0.1",
                        help="адрес прослушивания (по умолчанию только этот компьютер)")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    run(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
