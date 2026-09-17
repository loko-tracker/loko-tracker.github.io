"""Задать логин и пароль для входа на сайт.

Пароль вводится скрытно (не отображается и не попадает в историю команд),
на диск уходит только его PBKDF2-хэш со случайной солью.

    python setup_login.py

Тем же скриптом пароль меняется: все открытые сессии после смены
перестают действовать.
"""

from __future__ import annotations

import getpass
import sys

import auth

MIN_LENGTH = 8


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if auth.is_configured():
        print("Вход уже настроен. Продолжить — значит заменить логин и пароль.")
        if input("Заменить? [y/N]: ").strip().lower() not in ("y", "yes", "д", "да"):
            print("Оставил как было.")
            return 0
        print()

    login = input("Логин: ").strip()
    if not login:
        print("Логин не может быть пустым.")
        return 1

    while True:
        password = getpass.getpass("Пароль (не отображается): ")
        if len(password) < MIN_LENGTH:
            print(f"Коротко — нужно минимум {MIN_LENGTH} символов. Ещё раз.\n")
            continue
        repeat = getpass.getpass("Пароль ещё раз: ")
        if password != repeat:
            print("Не совпали. Ещё раз.\n")
            continue
        break

    path = auth.save_credentials(login, password)
    print()
    print(f"Готово. Хэш записан в {path}")
    print("Сам пароль нигде не сохранён — восстановить его нельзя,")
    print("но можно задать новый, запустив этот скрипт снова.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
