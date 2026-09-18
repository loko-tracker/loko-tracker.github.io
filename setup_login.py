"""Задать логин и пароль — сразу для обеих версий сайта.

  * локальная (refresh.bat): хранится PBKDF2-хэш пароля;
  * публичная (ссылка на claude.ai): из логина и пароля выводится ключ,
    которым шифруются данные страницы. Хранится ключ, не пароль.

Пароль вводится скрытно — не отображается и не попадает в историю команд.

    python setup_login.py

Тем же скриптом пароль меняется. После смены все открытые сессии и
«запомненные» устройства перестают подходить, и публичную страницу нужно
пересобрать — refresh.bat или ежедневное обновление сделают это сами.
"""

from __future__ import annotations

import getpass
import sys

import auth
import webkey

MIN_LENGTH = webkey.MIN_PASSWORD

# Согласие принимаем в любой раскладке: русская «у» выглядит как латинская
# «y», и её вводят не задумываясь. «н» здесь нет намеренно — это «нет».
YES = {"да", "д", "y", "yes", "у", "ага", "ok", "ок"}


def confirmed(answer: str) -> bool:
    return answer.strip().lower().rstrip(".!") in YES


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print()
    print("  Логин и пароль для сайта КХЛ")
    print("  Подойдут и на компьютере, и по ссылке с телефона.")
    print()

    if auth.is_configured() or webkey.is_configured():
        print("  Вход уже был настроен. Продолжить — значит заменить логин и пароль.")
        if not confirmed(input("  Заменить? Напиши да или нет: ")):
            print("  Оставил как было.")
            return 0
        print()

    login = input("  Логин: ").strip()
    if not login:
        print("  Логин не может быть пустым.")
        return 1

    print()
    print(f"  Пароль — не короче {MIN_LENGTH} символов. Лучше несколько слов")
    print("  или случайный набор: от его стойкости зависит защита сайта.")
    print("  При вводе символы НЕ отображаются — так и должно быть.")
    print()

    while True:
        password = getpass.getpass("  Пароль: ")
        if len(password) < MIN_LENGTH:
            print(f"  Коротко — нужно минимум {MIN_LENGTH} символов. Ещё раз.\n")
            continue
        if password.lower() == login.lower():
            print("  Пароль не должен совпадать с логином. Ещё раз.\n")
            continue
        repeat = getpass.getpass("  Пароль ещё раз: ")
        if password != repeat:
            print("  Не совпали. Ещё раз.\n")
            continue
        break

    print()
    print("  Вычисляю ключ (пару секунд)…")
    auth.save_credentials(login, password)
    webkey.create(login, password)

    print()
    print("  Готово.")
    print(f"  Логин: {login}   (регистр букв при входе не важен)")
    print("  Сам пароль нигде не сохранён — восстановить его нельзя,")
    print("  только задать новый, запустив этот файл снова.")
    print()
    print("  Чтобы новый пароль заработал на сайте по ссылке, запусти refresh.bat")
    print("  (или дождись утреннего автообновления).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
