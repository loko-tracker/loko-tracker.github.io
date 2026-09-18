"""Вход по логину и паролю для локального сервера.

Только стандартная библиотека. Что важно:

  * пароль не хранится — только PBKDF2-HMAC-SHA256 со случайной солью;
  * сессия — кука, подписанная HMAC на случайном серверном секрете,
    так что подделать её без файла auth.json нельзя;
  * сравнения через compare_digest, чтобы не сливать информацию
    через время ответа;
  * после серии неудач вход по этому адресу временно запирается.

Файл data/auth.json содержит хэш и секрет подписи — это не публичные
данные, в чужие руки его отдавать не стоит.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

DATA = Path(__file__).parent / "data"
AUTH_FILE = DATA / "auth.json"

PBKDF2_ROUNDS = 200_000
SALT_BYTES = 16
SESSION_HOURS = 12
COOKIE_NAME = "khl_session"

# Защёлка от подбора: после MAX_FAILS неудач с одного адреса вход
# запирается на LOCKOUT_SECONDS.
MAX_FAILS = 6
LOCKOUT_SECONDS = 300
FAIL_DELAY = 0.4          # ответ на неверный пароль всегда медленный


class AuthNotConfigured(RuntimeError):
    pass


# ------------------------------------------------------------------ хранение

def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or os.urandom(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS
    )
    return base64.b64encode(salt).decode(), base64.b64encode(digest).decode()


def save_credentials(login: str, password: str) -> Path:
    """Перезаписывает файл входа. Секрет подписи меняется, поэтому
    все открытые сессии после смены пароля становятся недействительными."""
    DATA.mkdir(exist_ok=True)
    salt_b64, hash_b64 = hash_password(password)
    AUTH_FILE.write_text(
        json.dumps(
            {
                "login": login,
                "salt": salt_b64,
                "hash": hash_b64,
                "rounds": PBKDF2_ROUNDS,
                "secret": secrets.token_hex(32),
                "updated_at": dt.datetime.now().isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    try:                      # на Windows отработает не всегда — это нормально
        os.chmod(AUTH_FILE, 0o600)
    except OSError:
        pass
    return AUTH_FILE


def is_configured() -> bool:
    return AUTH_FILE.exists()


def _load() -> dict:
    if not AUTH_FILE.exists():
        raise AuthNotConfigured(
            "вход не настроен — запусти: python setup_login.py"
        )
    return json.loads(AUTH_FILE.read_text(encoding="utf-8"))


# -------------------------------------------------------------------- проверка

def check_password(login: str, password: str) -> bool:
    data = _load()
    salt = base64.b64decode(data["salt"])
    expected = base64.b64decode(data["hash"])
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, data.get("rounds", PBKDF2_ROUNDS)
    )
    # Оба сравнения выполняем всегда, чтобы время ответа не выдавало,
    # что именно не сошлось — логин или пароль. Регистр логина не важен:
    # так же устроен вход в публичную версию, и телефонная клавиатура,
    # поставившая заглавную букву, не должна мешать войти.
    login_ok = hmac.compare_digest(
        login.strip().lower().encode("utf-8"),
        data["login"].strip().lower().encode("utf-8"),
    )
    password_ok = hmac.compare_digest(digest, expected)
    return login_ok and password_ok


# -------------------------------------------------------------------- сессии

def issue_session() -> tuple[str, dt.datetime]:
    """Возвращает значение куки и момент истечения."""
    data = _load()
    expires = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=SESSION_HOURS)
    payload = f"{data['login']}|{int(expires.timestamp())}"
    signature = hmac.new(
        data["secret"].encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    token = base64.urlsafe_b64encode(f"{payload}|{signature}".encode()).decode()
    return token, expires


def verify_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        data = _load()
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        login, expires_at, signature = raw.rsplit("|", 2)
        payload = f"{login}|{expires_at}"
        expected = hmac.new(
            data["secret"].encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        if not hmac.compare_digest(login, data["login"]):
            return False
        return time.time() < float(expires_at)
    except Exception:
        return False


def cookie_header(token: str, expires: dt.datetime, *, secure: bool = False) -> str:
    stamp = expires.strftime("%a, %d %b %Y %H:%M:%S GMT")
    parts = [
        f"{COOKIE_NAME}={token}",
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        f"Expires={stamp}",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header() -> str:
    return (
        f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; "
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    )


def read_cookie(cookie_header_value: str | None) -> str | None:
    if not cookie_header_value:
        return None
    for chunk in cookie_header_value.split(";"):
        name, _, value = chunk.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return None


# ------------------------------------------------------------------- защёлка

class Lockout:
    """Счётчик неудачных попыток в памяти процесса.

    Хранить его на диске смысла нет: сервер локальный и живёт один сеанс,
    а перезапуск ради сброса счётчика требует доступа к машине — то есть
    того, против чего пароль всё равно не защищает.
    """

    def __init__(self):
        self._fails: dict[str, list[float]] = {}

    def locked_for(self, client: str) -> int:
        """Сколько секунд осталось до разблокировки (0 — открыто)."""
        stamps = [t for t in self._fails.get(client, []) if time.time() - t < LOCKOUT_SECONDS]
        self._fails[client] = stamps
        if len(stamps) < MAX_FAILS:
            return 0
        return int(LOCKOUT_SECONDS - (time.time() - stamps[-1])) + 1

    def record_failure(self, client: str) -> None:
        self._fails.setdefault(client, []).append(time.time())

    def reset(self, client: str) -> None:
        self._fails.pop(client, None)
