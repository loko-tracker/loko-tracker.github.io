"""Лазарет: ручные отметки плюс автоматический разбор новостей.

Структурированного источника травм по КХЛ не существует — ни в API лиги,
ни где-либо ещё. Поэтому два механизма:

1. РУЧНЫЕ отметки. Ты сам отмечаешь игрока на странице, запись уходит
   в data/injuries.json и живёт там, пока ты её не снимешь. Это основной,
   надёжный источник, и обновление данных его никогда не затирает.

2. АВТОМАТИЧЕСКИЙ разбор новостных заголовков. Скрипт читает раздел хоккея
   на sports.ru, отбирает заголовки со словами про травмы и сверяет
   фамилии с реальными составами КХЛ, полученными из API.

Сверка с составами — главный фильтр точности: в хоккейной ленте полно
новостей про НХЛ, и без неё список был бы наполовину из чужих игроков.
Но совпадение по фамилии всё равно остаётся догадкой, поэтому у каждой
автозаписи есть пометка надёжности, а на странице они отделены от ручных.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import re
import urllib.request
from pathlib import Path

DATA = Path(__file__).parent / "data"
INJURIES_FILE = DATA / "injuries.json"

SOURCES = [
    "https://www.sports.ru/hockey/news/",
    "https://www.sports.ru/hockey/",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9",
}

INJURY_WORDS = re.compile(
    r"травм|выбы|пропустит|пропуска|лазарет|операц|поврежд|сломал|"
    r"дисквалифи|вне игры|не сыграет|восстанов|разрыв|перелом|сотрясен",
    re.IGNORECASE,
)

# Слова, которые почти всегда означают, что речь не о выбывании
# конкретного игрока нашей лиги.
NOISE_WORDS = re.compile(r"НХЛ|Н\.?Х\.?Л|драфт|юниор|МХЛ|ЖХЛ", re.IGNORECASE)

TERM_PATTERNS = [
    (re.compile(r"до конца сезона", re.I), "до конца сезона"),
    (re.compile(r"до\s+(?:середины|начала|конца)\s+\w+", re.I), None),
    (re.compile(r"на\s+\d+[-–]\d+\s+(?:недел\w*|месяц\w*|матч\w*|дн\w*)", re.I), None),
    (re.compile(r"на\s+\d+\s+(?:недел\w*|месяц\w*|матч\w*|дн\w*)", re.I), None),
    (re.compile(r"на\s+(?:месяц|неделю|полгода)", re.I), None),
]

TIMEOUT = 30


# ------------------------------------------------------------------- загрузка

def _fetch(url: str) -> str:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


def _headlines(page: str) -> list[tuple[str, str]]:
    """(текст, ссылка) для каждого правдоподобного заголовка на странице."""
    found: dict[str, str] = {}
    pattern = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>([^<]{25,200})</a>')
    for match in pattern.finditer(page):
        href, text = match.group(1), html.unescape(match.group(2)).strip()
        if not text or text.startswith("http"):
            continue
        if href.startswith("/"):
            href = "https://www.sports.ru" + href
        found.setdefault(text, href)
    return list(found.items())


# -------------------------------------------------------------------- разбор

def _surname(full_name: str) -> str:
    """API отдаёт «Фамилия Имя», в новостях чаще всего одна фамилия."""
    return (full_name or "").split()[0] if full_name else ""


# Прилагательные окончания фамилий: «Тертышный» в новости почти всегда
# стоит в падеже — «Тертышного», «Тертышному». Отрезаем окончание и ищем
# основу, иначе такие фамилии не находятся вообще никогда.
ADJ_ENDINGS = ("ый", "ий", "ой", "ая", "яя", "ых", "их")


def _stem(surname: str) -> str:
    text = (surname or "").lower()
    for ending in ADJ_ENDINGS:
        if text.endswith(ending) and len(text) - len(ending) >= 4:
            return text[: -len(ending)]
    return text


# Названия клубов в API и в новостях расходятся: «Динамо М» против
# «Динамо», «Металлург Мг» против «Металлурга», «ХК Сочи» против «Сочи».
CLUB_SUFFIXES = (" мг", " м", " мн", " ю")
CLUB_PREFIXES = ("хк ",)
CLUB_ALIASES = {
    "драконы": ["шанхай", "дракон"],
    "ска": ["ска"],
    "цска": ["цска"],
}


def _club_keys(team: dict) -> list[str]:
    """Строки, по которым клуб можно узнать в новостном заголовке."""
    name = (team.get("name") or "").lower().strip()
    keys = set()
    if name:
        keys.add(name)
        short = name
        for prefix in CLUB_PREFIXES:
            if short.startswith(prefix):
                short = short[len(prefix):]
        for suffix in CLUB_SUFFIXES:
            if short.endswith(suffix):
                short = short[: -len(suffix)]
                break
        short = short.strip()
        if len(short) >= 3:
            keys.add(short)
        keys.update(CLUB_ALIASES.get(name, []))
    location = (team.get("location") or "").lower().strip()
    if len(location) >= 4:
        keys.add(location)
    return [k for k in keys if k]


def _find_term(text: str) -> str | None:
    for pattern, fixed in TERM_PATTERNS:
        match = pattern.search(text)
        if match:
            return fixed or match.group(0).strip()
    return None


def scan_news(players: list[dict], teams: list[dict] | None = None,
              progress=print) -> list[dict]:
    """Ищет в новостях упоминания травм игроков КХЛ."""
    # Основа фамилии -> игроки с такой фамилией (бывают полные тёзки)
    by_stem: dict[str, list[dict]] = {}
    for player in players:
        surname = _surname(player.get("name", ""))
        if len(surname) >= 4:                  # короткие фамилии дают мусор
            stem = _stem(surname)
            if len(stem) >= 4:
                by_stem.setdefault(stem, []).append(player)

    # Ключи клубов берём из справочника команд: у части игроков поле team
    # приходит пустым, и строить список по ним было бы ненадёжно.
    club_keys: dict[str, str] = {}             # ключ в тексте -> имя клуба
    for team in teams or ():
        for key in _club_keys(team):
            club_keys.setdefault(key, team.get("name") or "")

    headlines: dict[str, str] = {}
    for url in SOURCES:
        try:
            page = _fetch(url)
        except Exception as error:
            progress(f"  не прочитал {url}: {type(error).__name__}")
            continue
        for text, href in _headlines(page):
            headlines.setdefault(text, href)
    progress(f"  заголовков просмотрено: {len(headlines)}")

    results: list[dict] = []
    for text, href in headlines.items():
        if not INJURY_WORDS.search(text):
            continue

        lowered = text.lower().replace("\xa0", " ")
        mentioned_clubs = {club_keys[k] for k in club_keys if k in lowered}

        for stem, candidates in by_stem.items():
            # Основа фамилии плюс до четырёх букв падежного окончания
            if not re.search(rf"\b{re.escape(stem)}\w{{0,4}}\b", lowered):
                continue

            # Если в заголовке назван клуб, оставляем игроков этого клуба
            narrowed = candidates
            if mentioned_clubs:
                same_club = [p for p in candidates if (p.get("team") or "") in mentioned_clubs]
                if same_club:
                    narrowed = same_club

            if len(narrowed) == 1 and (mentioned_clubs or not NOISE_WORDS.search(text)):
                confidence = "высокая" if mentioned_clubs else "средняя"
            elif mentioned_clubs:
                confidence = "средняя"
            else:
                confidence = "низкая"

            for player in narrowed:
                # У части игроков API не отдаёт клуб. Если в заголовке
                # назван ровно один клуб, подставляем его.
                team_name = player.get("team")
                if not team_name and len(mentioned_clubs) == 1:
                    team_name = next(iter(mentioned_clubs))

                results.append(
                    {
                        "player": player.get("name"),
                        "player_id": player.get("id"),
                        "team": team_name,
                        "team_id": player.get("team_id"),
                        "headline": text,
                        "url": href,
                        "term": _find_term(text),
                        "confidence": confidence,
                        "found_at": dt.datetime.now().isoformat(timespec="seconds"),
                    }
                )

    # Один игрок — одна запись: оставляем самую надёжную
    rank = {"высокая": 0, "средняя": 1, "низкая": 2}
    best: dict[int, dict] = {}
    for item in results:
        key = item["player_id"]
        if key not in best or rank[item["confidence"]] < rank[best[key]["confidence"]]:
            best[key] = item

    out = sorted(best.values(), key=lambda r: (rank[r["confidence"]], r["player"] or ""))
    progress(f"  похоже на травмы игроков КХЛ: {len(out)}")
    return out


# ------------------------------------------------------------------ хранение

def _empty() -> dict:
    return {"updated_at": None, "manual": [], "auto": []}


def load() -> dict:
    if not INJURIES_FILE.exists():
        return _empty()
    try:
        data = json.loads(INJURIES_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty()
    data.setdefault("manual", [])
    data.setdefault("auto", [])
    return data


def save(data: dict) -> Path:
    DATA.mkdir(exist_ok=True)
    data["updated_at"] = dt.datetime.now().isoformat(timespec="seconds")
    INJURIES_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return INJURIES_FILE


def refresh_auto(players: list[dict], teams: list[dict] | None = None,
                 progress=print) -> dict:
    """Пересобирает автоматическую часть, ручную оставляет как есть."""
    data = load()
    data["auto"] = scan_news(players, teams, progress=progress)
    save(data)
    return data


def merged(data: dict | None = None) -> list[dict]:
    """Единый список для страницы: ручные записи вытесняют автоматические."""
    data = data or load()
    manual_ids = {m.get("player_id") for m in data.get("manual", []) if m.get("player_id")}
    manual_names = {(m.get("player") or "").lower() for m in data.get("manual", [])}

    out = []
    for item in data.get("manual", []):
        out.append({**item, "source": "manual"})
    for item in data.get("auto", []):
        if item.get("player_id") in manual_ids:
            continue
        if (item.get("player") or "").lower() in manual_names:
            continue
        out.append({**item, "source": "auto"})
    return out


if __name__ == "__main__":
    import sys
    import collect

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    season = collect.load()
    data = refresh_auto(season["players"], season["teams"])
    print()
    for item in merged(data):
        mark = "✓" if item["source"] == "manual" else "?"
        print(f"  {mark} {item.get('player'):<26} {item.get('team') or '':<16} "
              f"{item.get('term') or item.get('until') or '—'}")
