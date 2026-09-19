"""Полный цикл: собрать данные → разобрать травмы → посчитать шансы → открыть сайт.

Это то, что запускает refresh.bat.

    python run.py                  # всё целиком и открыть браузер
    python run.py --no-fetch       # пересобрать страницу из уже скачанных данных
    python run.py --sims 20000     # точнее посчитать шансы (дольше)
    python run.py --no-serve       # только обновить данные, не поднимать сервер
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback

import auth
import build
import club_media
import club_roster
import collect
import injuries as injuries_module
import serve
import site_pages
import vendor
import webkey


def step(title: str) -> None:
    print()
    print("=" * 62)
    print(" " + title)
    print("=" * 62)


def main() -> int:
    parser = argparse.ArgumentParser(description="Обновить данные и открыть трекер КХЛ")
    parser.add_argument("--no-fetch", action="store_true", help="не ходить в API, взять сохранённое")
    parser.add_argument("--no-serve", action="store_true", help="не поднимать сервер")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--no-news", action="store_true", help="пропустить разбор новостей о травмах")
    parser.add_argument("--sims", type=int, default=10_000, help="число симуляций (по умолчанию 10000)")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    started = time.time()

    # Библиотеки лежат локально; если их нет — доложим один раз.
    if not (vendor.VENDOR / "gsap.min.js").exists():
        step("Библиотеки оформления")
        vendor.fetch_libs()

    season = None
    if args.no_fetch:
        print("Беру сохранённые данные (--no-fetch).")
        season = collect.load()
    else:
        step("Данные из API КХЛ")
        try:
            season = collect.collect()
            step("Официальные составы клубов")
            club_roster.apply(season)
            club_media.sync(season)
            collect.save(season)
        except Exception:
            traceback.print_exc()
            print()
            print("  API не ответил. Пробую взять сохранённые данные…")
            try:
                season = collect.load()
            except SystemExit:
                print("  Сохранённых данных тоже нет — попробуй позже.")
                return 1

    if not (vendor.LOGOS / "26.png").exists():
        step("Логотипы клубов")
        vendor.fetch_logos()

    if not args.no_news:
        step("Упоминания травм в новостях")
        try:
            injuries_module.refresh_auto(season["players"], season["teams"])
        except Exception as error:
            # Новости — необязательная часть: без них сайт полноценен.
            print(f"  не получилось ({type(error).__name__}) — ручные отметки не тронуты")

    step(f"Шансы на плей-офф: {args.sims} симуляций")
    payload = build.build(season, sims=args.sims)
    path = build.save(payload)
    print(f"  готово: {path.name}, {path.stat().st_size / 1024:.0f} КБ")

    step("Страницы сайта")
    site_pages.write_local()
    print("  локальная версия: web/index.html")
    if webkey.is_configured():
        page = site_pages.write_web(payload)
        check = site_pages.self_check()
        print(f"  публичная версия: {page.relative_to(page.parents[1])}, {check['size_kb']} КБ, "
              f"данные зашифрованы и проверены ({check['games']} матчей)")
    else:
        print("  публичная версия не собрана: пароль для сайта ещё не задан (setup-login.bat)")

    summary = payload["summary"]
    print()
    print(f"  Сыграно {summary['games_played']} из {summary['games_total']} матчей · "
          f"{summary['players']} игроков · {len(payload['injuries'])} отметок в лазарете")
    print(f"  Всё заняло {time.time() - started:.0f} с")

    if args.no_serve:
        return 0

    # Пароль нужен только для сервера: данные собираются и без него.
    if not auth.is_configured():
        print()
        print("  Данные обновлены, но сайт закрыт паролем — его ещё нужно задать:")
        print()
        print("      setup-login.bat      (или: python setup_login.py)")
        print()
        print("  После этого запусти refresh.bat снова.")
        return 1

    step("Сайт")
    serve.run(args.host, args.port, open_browser=not args.no_browser)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
