"""Собирает страницы из общей разметки web/shell.html.

  * web/index.html + web/logos.css — локальная версия (её отдаёт serve.py);
  * publish/khl-tracker.html      — публичная: сайт открыт, данные лежат
                                    рядом файлом data.json, как и код,
                                    стили, логотипы и фото игроков;
  * publish/index.html           — та же публичная страница, обёрнутая
                                    в полный документ: её открывают у себя,
                                    её же отдаёт GitHub Pages (публикуется
                                    папка publish целиком).

Публичная страница собрана по правилам страниц claude.ai: без собственных
<html>/<head>/<body> (обёртку добавляет платформа), внешние скрипты только
с cdnjs и jsdelivr, свои файлы — рядом со страницей: чужие адреса там
заблокированы.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
WEB = ROOT / "web"
LOGOS = WEB / "logos"
PHOTOS = WEB / "photos"
PUBLISH = ROOT / "publish"
SITE_DATA = ROOT / "data" / "site_data.json"

WEB_PAGE = PUBLISH / "khl-tracker.html"
PAGES_INDEX = PUBLISH / "index.html"

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
    """Свои картинки, которые публикуются рядом со страницей.

    Таких больше нет: фотографии игроков, снимки с матчей и картинки
    новостей остались у клуба и у лиги, а в данных на них стоят ссылки.
    Функция сохранена, чтобы старые снимки убирались из публикации
    и чтобы было куда вернуть свои картинки, если они появятся.
    """
    if payload is None:
        try:
            payload = json.loads(SITE_DATA.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
    return []


# ------------------------------------------------------------ поиск и ссылки

SITE_CONFIG = ROOT / "site.json"


def _site_url() -> str:
    try:
        url = json.loads(SITE_CONFIG.read_text(encoding="utf-8")).get("site_url") or ""
    except (OSError, ValueError):
        return ""
    return url.rstrip("/")


def _season_label(season: str | None) -> str:
    """«2026/2027» -> «2026/27»: так короче и так же пишет сама лига."""
    text = str(season or "")
    return f"{text[:4]}/{text[-2:]}" if "/" in text else text


def _page_title(payload: dict | None = None) -> str:
    club, season = _club_name(payload), _season_label((payload or {}).get("season"))
    return f"«{club}» — трекер сезона КХЛ {season}" if club and season else TITLE


def _coach(name: str | None) -> str:
    """В таблице тренер записан фамилией вперёд — читателю привычнее наоборот."""
    parts = str(name or "").split()
    return " ".join([parts[1], parts[0]]) if len(parts) >= 2 else str(name or "")


def _verify_meta() -> list[str]:
    """Подтверждение прав в Яндекс.Вебмастере и Google Search Console."""
    try:
        codes = json.loads(SITE_CONFIG.read_text(encoding="utf-8")).get("verify") or {}
    except (OSError, ValueError):
        return []
    names = {"yandex": "yandex-verification", "google": "google-site-verification"}
    return [f'<meta name="{names[key]}" content="{codes[key]}">'
            for key in ("yandex", "google") if codes.get(key)]


def _counter() -> list[str]:
    """Счётчик посещений: сколько людей заходит и откуда.

    Официальный код Яндекс.Метрики, но без вебвизора — записывать, как
    посетитель водит мышью по странице, для трекера ни к чему.
    """
    try:
        number = str(json.loads(SITE_CONFIG.read_text(encoding="utf-8")).get("metrika") or "").strip()
    except (OSError, ValueError):
        return []
    if not number.isdigit():
        return []
    return ["""<!-- Yandex.Metrika counter -->
<script>
(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
m[i].l=1*new Date();
for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window, document, "script", "https://mc.yandex.ru/metrika/tag.js?id=NUMBER", "ym");
ym(NUMBER, "init", {ssr: true, clickmap: true, trackLinks: true, accurateTrackBounce: true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/NUMBER" style="position:absolute; left:-9999px" alt=""></div></noscript>
<!-- /Yandex.Metrika counter -->""".replace("NUMBER", number)]


def _standing(payload: dict) -> dict:
    """Строка своего клуба в таблице — из неё складывается описание сайта."""
    mine = payload.get("my_team_id")
    for table in (payload.get("standings") or {}).values():
        for row in table:
            if row.get("team_id") == mine:
                return row
    return {}


def _next_game(payload: dict) -> dict:
    mine = payload.get("my_team_id")
    for game in payload.get("games") or ():
        if game.get("state") != "finished" and mine in (game.get("home_id"), game.get("away_id")):
            return game
    return {}


def _description(payload: dict) -> str:
    """Строка под ссылкой в поиске. Пересобирается каждый день вместе с сайтом."""
    row, club = _standing(payload), ""
    for team in payload.get("teams") or ():
        if team.get("id") == payload.get("my_team_id"):
            club = team.get("name") or ""
    parts = [f"«{club}» в сезоне КХЛ {_season_label(payload.get('season'))}" if club else "Сезон КХЛ"]
    if row.get("gp"):
        parts.append(f"{row.get('position')}-е место на {'Западе' if row.get('conference_key') == 'west' else 'Востоке'}, "
                     f"{row.get('pts')} очков в {row.get('gp')} матчах")
    parts.append("Расписание, счёт, статистика игроков, лазарет и шансы на плей-офф")
    return ". ".join(parts) + "."


def _noscript(payload: dict) -> str:
    """Текст для поисковиков: страница рисуется сценарием, а роботы читают HTML.

    Поэтому тот же расклад коротко повторён обычным текстом. Люди его не
    видят: браузер показывает <noscript> только когда сценарии отключены.
    """
    row = _standing(payload)
    if not row:
        return ""
    game = _next_game(payload)
    rival = ""
    if game:
        mine = payload.get("my_team_id")
        rival = game.get("away") if game.get("home_id") == mine else game.get("home")
        rival = f"{rival} ({'дома' if game.get('home_id') == mine else 'в гостях'})"
    players = [p for p in payload.get("players") or () if p.get("team_id") == payload.get("my_team_id")]
    top = sorted(players, key=lambda p: (p.get("pts") or 0), reverse=True)[:3]
    scorers = ", ".join(f"{p['name']} ({p.get('pts', 0)})" for p in top)
    return (
        "<noscript>"
        f"<h1>«{row.get('name')}» — сезон КХЛ {_season_label(payload.get('season'))}</h1>"
        f"<p>{row.get('position')}-е место в конференции {row.get('conference')}, "
        f"{row.get('pts')} очков в {row.get('gp')} матчах, шайбы {row.get('gf')}:{row.get('ga')}. "
        f"Тренер — {_coach(row.get('coach'))}.</p>"
        + (f"<p>Следующий матч: {rival}.</p>" if rival else "")
        + (f"<p>Лучшие бомбардиры клуба: {scorers}.</p>" if scorers else "")
        + "<p>На сайте: расписание и результаты всех матчей КХЛ, таблица, статистика игроков, "
          "разбор матчей с голами и словами тренера, история клуба и шансы на плей-офф. "
          "Для просмотра нужен включённый JavaScript.</p>"
        "</noscript>"
    )


def _head_meta(payload: dict) -> list[str]:
    """Описание сайта и карточка для ссылки в мессенджерах и соцсетях."""
    url, text = _site_url(), _description(payload)
    tags = [f'<meta name="description" content="{text}">']
    if not url:
        return tags
    image = f"{url}/logos/{payload.get('my_team_id')}.png"
    return tags + [
        f'<link rel="canonical" href="{url}/">',
        f'<meta property="og:type" content="website">',
        f'<meta property="og:title" content="{_page_title(payload)}">',
        f'<meta property="og:description" content="{text}">',
        f'<meta property="og:url" content="{url}/">',
        f'<meta property="og:image" content="{image}">',
        f'<meta name="twitter:card" content="summary">',
    ]


# ----------------------------------------------------------------- локальная

def _my_team_id(payload: dict | None = None) -> int | None:
    """Клуб сайта: его логотип становится иконкой вкладки и меткой в шапке."""
    if payload and payload.get("my_team_id") is not None:
        return payload["my_team_id"]
    try:
        return json.loads(SITE_DATA.read_text(encoding="utf-8")).get("my_team_id")
    except (OSError, ValueError):
        return None


def _icon_head(team_id, prefix: str) -> list[str]:
    """То, что должно стоять именно в <head>: значок и описание приложения.

    Браузер ищет значок в заголовке документа. В публичной версии страница
    отдаётся без своего <head> (его добавляет claude.ai), поэтому ссылки
    попадали в тело — и значок не подхватывался. На отдельном сайте
    (GitHub Pages) заголовок наш, и всё это кладётся туда.
    """
    if team_id is None or not (LOGOS / f"{team_id}.png").exists():
        return []
    href = f"{prefix}logos/{team_id}.png"
    return [
        f'<link rel="icon" type="image/png" href="{href}">',
        f'<link rel="apple-touch-icon" href="{href}">',
        f'<link rel="manifest" href="{prefix}site.webmanifest">',
        '<meta name="theme-color" content="#050810">',
    ]


def _write_favicon(team_id, folder: Path) -> None:
    """Запасной путь: браузеры сами просят /favicon.ico, даже без ссылки."""
    source = LOGOS / f"{team_id}.png" if team_id is not None else None
    if source is None or not source.exists():
        return
    try:
        from PIL import Image
    except ImportError:
        return
    with Image.open(source) as image:
        image.convert("RGBA").save(folder / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


def _manifest(team_id, club: str | None, prefix: str) -> str:
    """Имя и значок для «добавить на главный экран» телефона."""
    icons = []
    if team_id is not None and (LOGOS / f"{team_id}.png").exists():
        icons = [{"src": f"{prefix}logos/{team_id}.png", "sizes": "200x200", "type": "image/png"}]
    return json.dumps(
        {
            "name": TITLE,
            "short_name": club or "КХЛ",
            "start_url": prefix or ".",
            "scope": prefix or ".",
            "display": "standalone",
            "background_color": "#050810",
            "theme_color": "#050810",
            "icons": icons,
        },
        ensure_ascii=False,
        indent=1,
    )


def _club_name(payload: dict | None = None) -> str | None:
    data = payload
    if data is None:
        try:
            data = json.loads(SITE_DATA.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
    for team in data.get("teams") or ():
        if team.get("id") == data.get("my_team_id"):
            return team.get("name")
    return None


def _mark_css(team_id, prefix: str) -> str:
    if team_id is None or not (LOGOS / f"{team_id}.png").exists():
        return ""
    return f'.mark-crest{{background-image:url("{prefix}logos/{team_id}.png")}}\n'


def write_local() -> Path:
    club = _my_team_id()
    css = "".join(
        f'.logo-{i}{{background-image:url("/logos/{i}.png")}}\n' for i in _logo_ids()
    ) + _mark_css(club, "/")
    (WEB / "logos.css").write_text(css, encoding="utf-8")
    (WEB / "site.webmanifest").write_text(_manifest(club, _club_name(), "/"), encoding="utf-8")
    _write_favicon(club, WEB)

    page = "\n".join([
        "<!doctype html>",
        '<html lang="ru">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<meta name="color-scheme" content="dark">',
        f"<title>{_page_title()}</title>",
        *_icon_head(club, "/"),
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

# Всё, что не меняется каждый день, лежит рядом со страницей отдельными
# файлами: так сама страница остаётся крошечной, а данные обновляются
# заменой одного data.json.
STATIC_FILES = ["app.css", "app.js", "logos.css"]


def web_asset_map() -> dict[str, str]:
    """Опубликованный путь -> файл на диске, для первой публикации и
    для публикации после изменений в коде или оформлении."""
    files = {name: str(PUBLISH / name) for name in STATIC_FILES}
    files["data.json"] = str(PUBLISH / "data.json")
    files["site.webmanifest"] = str(PUBLISH / "site.webmanifest")
    for team_id in _logo_ids():
        files[f"logos/{team_id}.png"] = str(PUBLISH / "logos" / f"{team_id}.png")
    for name in _photo_names():
        files[f"photos/{name}"] = str(PUBLISH / "photos" / name)
    return files


def _web_head(payload: dict) -> list[str]:
    """Заголовок, описание и карточка ссылки — место им в <head>."""
    return [
        f"<title>{_page_title(payload)}</title>",
        '<meta name="color-scheme" content="dark">',
        *_head_meta(payload),
    ]


def _stamp(name: str) -> str:
    """«app.js» -> «app.js?v=1a2b3c4d»: отпечаток содержимого в адресе.

    GitHub Pages разрешает браузеру держать файл десять минут, поэтому
    после обновления сайта человек мог получить новую страницу со старым
    кодом. Сменилось содержимое — сменился адрес, и такого не выйдет.
    """
    target = PUBLISH / name
    try:
        digest = hashlib.sha256(target.read_bytes()).hexdigest()[:8]
    except OSError:
        return name
    return f"{name}?v={digest}"


def _web_body(payload: dict) -> list[str]:
    return [
        FONTS,
        f'<link rel="stylesheet" href="{_stamp("app.css")}">',
        f'<link rel="stylesheet" href="{_stamp("logos.css")}">',
        _noscript(payload),
        _variant(_shell(), "web"),
        # Адрес данных страница называет сама: у локальной версии их отдаёт
        # сервер, у опубликованной они лежат файлом рядом.
        f'<script>window.DATA_URL = "{_stamp("data.json")}";</script>',
        *[f'<script src="{src}"></script>' for src in CDN_SCRIPTS],
        f'<script src="{_stamp("app.js")}"></script>',
        "",
    ]


def build_web_page(payload: dict) -> str:
    return "\n".join([*_web_head(payload), *_web_body(payload)])


def _write_web_assets(payload: dict) -> None:
    import shutil

    (PUBLISH / "logos").mkdir(parents=True, exist_ok=True)
    (PUBLISH / "photos").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(WEB / "app.css", PUBLISH / "app.css")
    shutil.copyfile(WEB / "app.js", PUBLISH / "app.js")
    # Пути к логотипам относительные: файлы опубликованы рядом со страницей.
    (PUBLISH / "logos.css").write_text(
        "".join(f'.logo-{i}{{background-image:url("logos/{i}.png")}}\n' for i in _logo_ids())
        + _mark_css(_my_team_id(payload), ""),
        encoding="utf-8",
    )
    for team_id in _logo_ids():
        shutil.copyfile(LOGOS / f"{team_id}.png", PUBLISH / "logos" / f"{team_id}.png")
    url = _site_url()
    if url:
        (PUBLISH / "robots.txt").write_text(
            f"User-agent: *\nAllow: /\nSitemap: {url}/sitemap.xml\n", encoding="utf-8")
        stamp = str(payload.get("built_at") or "")[:10]
        (PUBLISH / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"<url><loc>{url}/</loc><lastmod>{stamp}</lastmod><changefreq>daily</changefreq></url>\n"
            "</urlset>\n", encoding="utf-8")
    (PUBLISH / "site.webmanifest").write_text(
        _manifest(_my_team_id(payload), _club_name(payload), ""), encoding="utf-8")
    _write_favicon(_my_team_id(payload), PUBLISH)
    wanted = set(_photo_names(payload))
    for name in wanted:
        target = PUBLISH / "photos" / name
        if not target.exists():                  # имя = отпечаток: не меняется
            shutil.copyfile(PHOTOS / name, target)
    # Лишнее убираем: на сайт уходит вся папка целиком, и снимки, на которые
    # больше никто не ссылается, иначе остались бы висеть.
    for stale in (PUBLISH / "photos").glob("*"):
        if stale.is_file() and stale.name not in wanted:
            stale.unlink()


def write_web(payload: dict) -> Path:
    PUBLISH.mkdir(exist_ok=True)
    _write_web_assets(payload)
    (PUBLISH / "data.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # Отпечатки берутся с уже записанных файлов, поэтому страница собирается
    # последней.
    page = build_web_page(payload)
    WEB_PAGE.write_text(page, encoding="utf-8")

    # Та же страница в полном документе: открыть у себя и проверить вход,
    # а в облаке это главная страница сайта на GitHub Pages.
    PAGES_INDEX.write_text(
        "\n".join([
            "<!doctype html>",
            '<html lang="ru">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
            *_icon_head(_my_team_id(payload), ""),
            *_verify_meta(),
            *_web_head(payload),
            "</head>",
            "<body>",
            *_web_body(payload),
            *_counter(),
            "</body>",
            "</html>",
            "",
        ]),
        encoding="utf-8",
    )
    # Без этого файла Pages прогоняет папку через Jekyll и выбрасывает всё,
    # что начинается с подчёркивания.
    (PUBLISH / ".nojekyll").write_text("", encoding="utf-8")
    return WEB_PAGE


def self_check() -> dict:
    """Проверяет, что страница собрана и данные рядом с ней читаются."""
    page = WEB_PAGE.read_text(encoding="utf-8")
    if "window.DATA_URL" not in page:
        raise ValueError("в странице нет ссылки на данные")
    data_file = PUBLISH / "data.json"
    data = json.loads(data_file.read_text(encoding="utf-8"))
    if not data.get("games"):
        raise ValueError("в данных нет матчей")
    return {
        "games": len(data.get("games", [])),
        "players": len(data.get("players", [])),
        "size_kb": round((WEB_PAGE.stat().st_size + data_file.stat().st_size) / 1024),
    }
