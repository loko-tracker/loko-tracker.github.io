"""Складывает фронтендовые библиотеки и логотипы клубов в web/vendor.

Всё качается один раз и лежит локально: сайт работает без интернета,
открывается мгновенно и не зависит от того, живы ли чужие CDN.

    python vendor.py            # библиотеки + логотипы
    python vendor.py --libs     # только библиотеки
    python vendor.py --logos    # только логотипы
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent import futures
from pathlib import Path

ROOT = Path(__file__).parent
VENDOR = ROOT / "web" / "vendor"
LOGOS = ROOT / "web" / "logos"
DATA = ROOT / "data"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    )
}

# Версии зафиксированы намеренно: обновление библиотеки не должно
# однажды молча сломать страницу.
LIBS = {
    "gsap.min.js":         "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js",
    "ScrollTrigger.min.js": "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollTrigger.min.js",
    "echarts.min.js":      "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js",
    "lenis.min.js":        "https://cdn.jsdelivr.net/npm/lenis@1.1.18/dist/lenis.min.js",
    "alpine.min.js":       "https://cdnjs.cloudflare.com/ajax/libs/alpinejs/3.14.1/cdn.min.js",
}


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def fetch_libs(progress=print) -> int:
    VENDOR.mkdir(parents=True, exist_ok=True)
    ok = 0

    def one(item):
        name, url = item
        try:
            body = _get(url)
        except Exception as error:
            return name, None, f"{type(error).__name__}"
        if len(body) < 2000:
            return name, None, f"подозрительно мало ({len(body)} б)"
        (VENDOR / name).write_bytes(body)
        return name, len(body), None

    with futures.ThreadPoolExecutor(max_workers=5) as pool:
        for name, size, error in pool.map(one, LIBS.items()):
            if error:
                progress(f"  ✗ {name}: {error}")
            else:
                progress(f"  ✓ {name}  {size / 1024:.0f} КБ")
                ok += 1
    return ok


def fetch_logos(progress=print) -> int:
    """Логотипы клубов из справочника команд, сохранённого сборщиком."""
    season_file = DATA / "season.json"
    if not season_file.exists():
        progress("  нет data/season.json — сначала собери данные (python collect.py)")
        return 0

    season = json.loads(season_file.read_text(encoding="utf-8"))
    teams = [t for t in season.get("teams", []) if t.get("image")]
    LOGOS.mkdir(parents=True, exist_ok=True)

    def one(team):
        name = f"{team['id']}.png"
        try:
            body = _get(team["image"])
        except Exception as error:
            return team.get("name"), None, type(error).__name__
        if len(body) < 300:
            return team.get("name"), None, "пустой файл"
        (LOGOS / name).write_bytes(body)
        return team.get("name"), len(body), None

    ok = 0
    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        for club, size, error in pool.map(one, teams):
            if error:
                progress(f"  ✗ {club}: {error}")
            else:
                ok += 1
    progress(f"  логотипов сохранено: {ok} из {len(teams)}")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description="Загрузка библиотек и логотипов")
    parser.add_argument("--libs", action="store_true")
    parser.add_argument("--logos", action="store_true")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    both = not (args.libs or args.logos)

    if args.libs or both:
        print("Библиотеки:")
        fetch_libs()
    if args.logos or both:
        print("Логотипы клубов:")
        fetch_logos()


if __name__ == "__main__":
    main()
