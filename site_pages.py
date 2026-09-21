"""Собирает страницы из общей разметки web/shell.html.

  * web/index.html + web/logos.css — локальная версия (её отдаёт serve.py);
  * publish/khl-tracker.html      — публичная: данные зашифрованы паролем
                                    (см. webkey.py), код, стили, логотипы
                                    и фото игроков — отдельными файлами рядом;
  * publish/preview.html          — та же публичная страница, обёрнутая
                                    в полный документ для проверки у себя.

Публичная страница собрана по правилам страниц claude.ai: без собственных
<html>/<head>/<body> (обёртку добавляет платформа), внешние скрипты только
с cdnjs и jsdelivr, свои файлы — рядом со страницей: чужие адреса там
заблокированы.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import webkey

ROOT = Path(__file__).parent
WEB = ROOT / "web"
LOGOS = WEB / "logos"
PHOTOS = WEB / "photos"
PUBLISH = ROOT / "publish"
SITE_DATA = ROOT / "data" / "site_data.json"

WEB_PAGE = PUBLISH / "khl-tracker.html"
PREVIEW_PAGE = PUBLISH / "preview.html"

TITLE = "Трекер сезона КХЛ"

FONTS = (
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700'
    '&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600'
    '&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap">'
)

# Те же версии, что лежат локально в web/vendor (см. vendor.py).
CDN_SCRIPTS = [
    "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollTrigger.min.js",
    "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js",
    "https://cdn.jsdelivr.net/npm/lenis@1.1.18/dist/lenis.min.js",
]
LOCAL_SCRIPTS = [
    "/vendor/gsap.min.js",
    "/vendor/ScrollTrigger.min.js",
    "/vendor/echarts.min.js",
    "/vendor/lenis.min.js",
]


# ------------------------------------------------------------------ разметка

def _variant(shell: str, keep: str) -> str:
    """Оставляет блоки одной версии (local/web) и вырезает блоки другой."""
    drop = "web" if keep == "local" else "local"
    shell = re.sub(rf"<!--{drop}-->.*?<!--/{drop}-->\s*", "", shell, flags=re.S)
    shell = re.sub(rf"<!--/?{keep}-->\s*", "", shell)
    # Служебный комментарий о сборке в итоговой странице не нужен.
    shell = re.sub(r"^<!-- Общая разметка.*?-->\s*", "", shell, flags=re.S)
    return shell.strip() + "\n"


def _shell() -> str:
    return (WEB / "shell.html").read_text(encoding="utf-8")


def _logo_ids() -> list[str]:
    if not LOGOS.exists():
        return []
    return sorted(p.stem for p in LOGOS.glob("*.png") if p.stem.isdigit())


def _photo_names(payload: dict | None = None) -> list[str]:
    """Фото, на которые ссылается текущая сборка, — и только они.

    Старые снимки остаются в web/photos как кэш, но на сайт не попадают.
    """
    if payload is None:
        try:
            payload = json.loads(SITE_DATA.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
    people = [m for roster in (payload.get("club_rosters") or {}).values() for m in roster]
    people += (payload.get("memorial") or {}).get("players", [])
    people += [{"photo": n.get("image")} for n in payload.get("club_news") or []]
    names = set()
    for member in people:
        for field in ("photo", "action"):
            name = member.get(field)
            if name and (PHOTOS / name).is_file():
                names.add(name)
    return sorted(names)


# ----------------------------------------------------------------- локальная

def write_local() -> Path:
    css = "".join(
        f'.logo-{i}{{background-image:url("/logos/{i}.png")}}\n' for i in _logo_ids()
    )
    (WEB / "logos.css").write_text(css, encoding="utf-8")

    page = "\n".join([
        "<!doctype html>",
        '<html lang="ru">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<meta name="color-scheme" content="dark">',
        f"<title>{TITLE}</title>",
        FONTS,
        '<link rel="stylesheet" href="/app.css">',
        '<link rel="stylesheet" href="/logos.css">',
        "</head>",
        "<body>",
        _variant(_shell(), "local"),
        *[f'<script src="{src}"></script>' for src in LOCAL_SCRIPTS],
        '<script src="/app.js"></script>',
        "</body>",
        "</html>",
        "",
    ])
    path = WEB / "index.html"
    path.write_text(page, encoding="utf-8")
    return path


# ---------------------------------------------------------------- публичная

# Неизменные части публичной версии лежат рядом со страницей отдельными
# файлами. Каждое утро меняется только зашифрованный блок внутри страницы,
# а перед заменой страницу приходится прочитать целиком — поэтому она
# должна быть маленькой: код, стили и логотипы в неё не встраиваются.
STATIC_FILES = ["app.css", "app.js", "logos.css"]


def web_asset_map() -> dict[str, str]:
    """Опубликованный путь -> файл на диске, для первой публикации и
    для публикации после изменений в коде или оформлении."""
    files = {name: str(PUBLISH / name) for name in STATIC_FILES}
    for team_id in _logo_ids():
        files[f"logos/{team_id}.png"] = str(PUBLISH / "logos" / f"{team_id}.png")
    for name in _photo_names():
        files[f"photos/{name}"] = str(PUBLISH / "photos" / name)
    return files


def build_web_page(payload: dict) -> str:
    vault = webkey.seal(payload)
    vault_json = json.dumps(
        {k: vault[k] for k in ("v", "kdf", "iterations", "salt", "iv", "data")},
        separators=(",", ":"),
    )

    body = _variant(_shell(), "web")
    # Пока не введён пароль, приложение скрыто — без вспышки пустой страницы.
    body = body.replace('<div class="app" id="app">', '<div class="app" id="app" hidden>', 1)

    return "\n".join([
        f"<title>{TITLE}</title>",
        '<meta name="color-scheme" content="dark">',
        '<meta name="robots" content="noindex, nofollow">',
        FONTS,
        '<link rel="stylesheet" href="app.css">',
        '<link rel="stylesheet" href="logos.css">',
        body,
        f'<script type="application/json" id="vault">{vault_json}</script>',
        *[f'<script src="{src}"></script>' for src in CDN_SCRIPTS],
        '<script src="app.js"></script>',
        "",
    ])


def _write_web_assets(payload: dict) -> None:
    import shutil

    (PUBLISH / "logos").mkdir(parents=True, exist_ok=True)
    (PUBLISH / "photos").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(WEB / "app.css", PUBLISH / "app.css")
    shutil.copyfile(WEB / "app.js", PUBLISH / "app.js")
    # Пути к логотипам относительные: файлы опубликованы рядом со страницей.
    (PUBLISH / "logos.css").write_text(
        "".join(f'.logo-{i}{{background-image:url("logos/{i}.png")}}\n' for i in _logo_ids()),
        encoding="utf-8",
    )
    for team_id in _logo_ids():
        shutil.copyfile(LOGOS / f"{team_id}.png", PUBLISH / "logos" / f"{team_id}.png")
    for name in _photo_names(payload):
        target = PUBLISH / "photos" / name
        if not target.exists():                  # имя = отпечаток: не меняется
            shutil.copyfile(PHOTOS / name, target)


def write_web(payload: dict) -> Path:
    PUBLISH.mkdir(exist_ok=True)
    _write_web_assets(payload)
    page = build_web_page(payload)
    WEB_PAGE.write_text(page, encoding="utf-8")

    # Та же страница в полном документе — открыть у себя и проверить вход.
    PREVIEW_PAGE.write_text(
        "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        "</head>\n<body>\n" + page + "</body>\n</html>\n",
        encoding="utf-8",
    )
    return WEB_PAGE


def self_check() -> dict:
    """Проверяет, что собранная страница расшифровывается сохранённым ключом."""
    page = WEB_PAGE.read_text(encoding="utf-8")
    match = re.search(r'<script type="application/json" id="vault">(.*?)</script>', page, re.S)
    if not match:
        raise ValueError("в странице нет зашифрованного блока")
    data = webkey.unseal_with_stored_key(json.loads(match.group(1)))
    return {
        "games": len(data.get("games", [])),
        "players": len(data.get("players", [])),
        "size_kb": round(WEB_PAGE.stat().st_size / 1024),
    }
