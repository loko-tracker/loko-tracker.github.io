"""Ключ шифрования для публичной версии сайта.

Публичная страница открывается у любого, кто знает ссылку, поэтому данные в
ней лежат зашифрованными. Расшифровать их может только тот, кто введёт
правильные логин и пароль: из них в браузере заново выводится тот же ключ.

Как это устроено:

  * ключ = PBKDF2-SHA256(логин + пароль, соль, ITERATIONS повторов);
    соль случайная и не секретная, она публикуется вместе со страницей;
  * данные сжимаются gzip и шифруются AES-256-GCM со случайным IV на
    каждую публикацию. GCM заодно проверяет целостность: неверный пароль
    даёт не «кашу», а честный отказ расшифровки;
  * локально хранится только выведенный ключ (data/web_key.json), а не
    пароль — он нужен, чтобы пересобирать страницу без повторного ввода.

Логин приводится к нижнему регистру и обрезается по краям: телефонная
клавиатура любит ставить заглавную первую букву, и из-за этого не должен
ломаться вход. Пароль сравнивается ровно как введён.

Стойкость защиты равна стойкости пароля: страницу можно скачать и перебирать
пароли у себя. ITERATIONS делает каждую попытку дорогой, но короткий или
словарный пароль это не спасёт, поэтому минимальная длина здесь больше,
чем у локального входа.
"""

from __future__ import annotations

import base64
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path

DATA = Path(__file__).parent / "data"
KEY_FILE = DATA / "web_key.json"

# В облаке (GitHub Actions) файла с ключом нет: его содержимое приходит
# секретом в переменной окружения, на диск не ложится.
KEY_ENV = "KHL_WEB_KEY"

ITERATIONS = 400_000
SALT_BYTES = 16
KEY_BYTES = 32
MIN_PASSWORD = 10


class WebKeyMissing(RuntimeError):
    pass


def normalize_login(login: str) -> str:
    return (login or "").strip().lower()


def derive(login: str, password: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    material = (normalize_login(login) + "\n" + password).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", material, salt, iterations, dklen=KEY_BYTES)


def create(login: str, password: str) -> Path:
    """Выводит ключ из логина и пароля и сохраняет его вместе с солью."""
    salt = os.urandom(SALT_BYTES)
    key = derive(login, password, salt)
    DATA.mkdir(exist_ok=True)
    KEY_FILE.write_text(
        json.dumps(
            {
                "kdf": "PBKDF2-SHA256",
                "iterations": ITERATIONS,
                "salt": base64.b64encode(salt).decode(),
                "key": base64.b64encode(key).decode(),
                "updated_at": dt.datetime.now().isoformat(timespec="seconds"),
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    try:
        os.chmod(KEY_FILE, 0o600)
    except OSError:
        pass
    return KEY_FILE


def is_configured() -> bool:
    return bool(os.environ.get(KEY_ENV)) or KEY_FILE.exists()


def load() -> dict:
    from_env = os.environ.get(KEY_ENV)
    if from_env:
        return json.loads(from_env)
    if not KEY_FILE.exists():
        raise WebKeyMissing(
            "ключ для сайта не задан — запусти setup-login.bat и введи логин и пароль"
        )
    return json.loads(KEY_FILE.read_text(encoding="utf-8"))


def seal(payload: dict) -> dict:
    """Сжимает и шифрует данные сайта. Возвращает то, что кладётся в страницу."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    stored = load()
    key = base64.b64decode(stored["key"])
    iv = os.urandom(12)

    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    sealed = AESGCM(key).encrypt(iv, packed, None)

    return {
        "v": 1,
        "kdf": stored["kdf"],
        "iterations": stored["iterations"],
        "salt": stored["salt"],
        "iv": base64.b64encode(iv).decode(),
        "data": base64.b64encode(sealed).decode(),
        "raw_bytes": len(raw),
        "packed_bytes": len(packed),
    }


def unseal(vault: dict, login: str, password: str) -> dict:
    """Обратная операция — для самопроверки перед публикацией."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = derive(login, password, base64.b64decode(vault["salt"]), vault["iterations"])
    packed = AESGCM(key).decrypt(
        base64.b64decode(vault["iv"]), base64.b64decode(vault["data"]), None
    )
    return json.loads(gzip.decompress(packed).decode("utf-8"))


def unseal_with_stored_key(vault: dict) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = base64.b64decode(load()["key"])
    packed = AESGCM(key).decrypt(
        base64.b64decode(vault["iv"]), base64.b64decode(vault["data"]), None
    )
    return json.loads(gzip.decompress(packed).decode("utf-8"))
