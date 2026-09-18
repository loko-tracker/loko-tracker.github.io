"""Собирает страницы из общей разметки web/shell.html.

  * web/index.html + web/logos.css — локальная версия (её отдаёт serve.py);
  * publish/khl-tracker.html      — публичная: всё в одном файле, данные
                                    зашифрованы паролем (см. webkey.py);
  * publish/preview.html          — та же публичная страница, обёрнутая
                                    в полный документ для проверки у себя.

Публичная страница собрана по правилам страниц claude.ai: без собственных
<html>/<head>/<body> (обёртку добавляет платформа), внешние скрипты только
с cdnjs и jsdelivr, картинки встроены — чужие адреса там заблокированы.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import webkey

ROOT = Path(__file__).parent
WEB = ROOT / "web"
LOGOS = WEB / "logos"
PUBLISH = ROOT / "publish"

WEB_PAGE = PUBLISH / "khl-tracker.html"
PREVIEW_PAGE = PUBLISH / "preview.html"

TITLE = "Трекер сезона КХЛ"

FONTS = (
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700'
    '&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">'
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


def _guard(text: str, closing: str, what: str) -> str:
    # Встроенный код не должен случайно закрыть свой собственный тег.
    if closing.lower() in text.lower():
        raise ValueError(f"в {what} встретилось «{closing}» — встраивание сломало бы страницу")
    return text


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

def _inline_logo_css() -> str:
    rules = []
    for team_id in _logo_ids():
        data = base64.b64encode((LOGOS / f"{team_id}.png").read_bytes()).decode()
        rules.append(f'.logo-{team_id}{{background-image:url("data:image/png;base64,{data}")}}')
    return "\n".join(rules)


def build_web_page(payload: dict) -> str:
    vault = webkey.seal(payload)
    vault_json = json.dumps(
        {k: vault[k] for k in ("v", "kdf", "iterations", "salt", "iv", "data")},
        separators=(",", ":"),
    )

    css = _guard((WEB / "app.css").read_text(encoding="utf-8"), "</style", "app.css")
    js = _guard((WEB / "app.js").read_text(encoding="utf-8"), "</script", "app.js")

    body = _variant(_shell(), "web")
    # Пока не введён пароль, приложение скрыто — без вспышки пустой страницы.
    body = body.replace('<div class="app" id="app">', '<div class="app" id="app" hidden>', 1)

    return "\n".join([
        f"<title>{TITLE}</title>",
        '<meta name="color-scheme" content="dark">',
        '<meta name="robots" content="noindex, nofollow">',
        FONTS,
        f"<style>\n{css}\n</style>",
        f"<style>\n{_inline_logo_css()}\n</style>",
        body,
        f'<script type="application/json" id="vault">{vault_json}</script>',
        *[f'<script src="{src}"></script>' for src in CDN_SCRIPTS],
        f"<script>\n{js}\n</script>",
        "",
    ])


def write_web(payload: dict) -> Path:
    PUBLISH.mkdir(exist_ok=True)
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
