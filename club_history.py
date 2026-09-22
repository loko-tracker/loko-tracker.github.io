"""История «Локомотива»: трофеи, награды, легенды, архив матчей.

Всё берётся с официального сайта клуба (api.hclokomotiv.ru):
  * achievements  — список трофеев клуба по годам (сам клуб его и ведёт,
    так что новые кубки появятся на сайте сами);
  * static-pages  — страницы «История» (текст клуба), «История» с перечнем
    командных и индивидуальных наград и «Известные игроки» (легенды
    с датами рождения);
  * games         — архив матчей основной команды с сезона 2017/18:
    для блока «В этот день» и рекордов за годы.

Несколько опорных событий, которых нет в списке трофеев (первая команда
1949 года, возвращение имени «Локомотив» в 2000-м, открытие «Арены-2000»,
катастрофа 2011 года), записаны здесь — по тем же страницам клуба.

Собранное лежит в data/club_history.json: если сайт клуба не ответит,
останется прежнее.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from pathlib import Path

import club_roster

DATA_FILE = Path(__file__).parent / "data" / "club_history.json"

PAGE_STORY = 9          # «ИСТОРИЯ» — рассказ клуба
PAGE_AWARDS = 12        # «История» — принципы и перечень наград
PAGE_LEGENDS = 17       # «ИЗВЕСТНЫЕ ИГРОКИ»

# Трофеи молодёжных команд в том же списке — их отсекаем.
YOUTH = ("мхл", "нмхл", "молодёжн", "молодежн", "локо-76", "год основания")

# Клубы меняли названия: в архиве они записаны как тогда.
ALIASES = {
    "динамо мск": "Динамо М",
    "куньлунь ред стар": "Драконы",
    "шанхайские драконы": "Драконы",
    "металлург": "Металлург Мг",
    "сочи": "ХК Сочи",
}


def _match_team(name: str, teams: list[dict]) -> int | None:
    """Имя соперника из архива -> клуб лиги. Кого уже нет в лиге — None."""
    wanted = ALIASES.get((name or "").strip().lower(), (name or "").strip())
    for team in teams or ():
        if (team.get("name") or "").strip().lower() == wanted.lower():
            return team.get("id")
    return None


# Опорные события по страницам клуба «ИСТОРИЯ» и «История».
MILESTONES = [
    {"year": "1949", "title": "Первая команда «Локомотив» в Ярославле",
     "text": "«Железнодорожники» впервые вышли на лёд в первенстве РСФСР.", "kind": "start"},
    {"year": "2000", "title": "Клуб снова называется «Локомотив»",
     "text": "«Торпедо» стало «Локомотивом», генеральным партнёром клуба выступило Министерство путей сообщения.", "kind": "start"},
    {"year": "2001", "title": "Открыта «Арена-2000»",
     "text": "В октябре 2001 года открылась домашняя арена клуба — одна из лучших в стране.", "kind": "start"},
    {"year": "2011", "title": "7 сентября: катастрофа под Туношной",
     "text": "Команда погибла по пути на первый матч сезона. Клуб возродился и вернулся к лидерам.", "kind": "memory"},
]


def _get(path: str, params: dict | None = None):
    query = "?" + urllib.parse.urlencode(params, safe="[]$*:") if params else ""
    return club_roster._get(f"{club_roster.LOKO_API}/{path}{query}")


def _kind(title: str) -> str:
    lower = title.lower()
    if "кубка гагарина" in lower or "чемпион россии" in lower or lower.startswith("чемпион"):
        return "gold"
    if "серебрян" in lower:
        return "silver"
    if "бронзов" in lower:
        return "bronze"
    if "обладатель" in lower:
        return "cup"
    return "start"


def fetch_achievements() -> list[dict]:
    payload = _get("achievements", {"pagination[pageSize]": "100", "sort": "id:asc"})
    out = []
    for item in payload.get("data") or ():
        entry = item.get("attributes") or {}
        title = (entry.get("title") or "").strip()
        if not title or any(mark in title.lower() for mark in YOUTH):
            continue
        out.append({"year": str(entry.get("period") or "").strip(), "title": title, "kind": _kind(title)})
    return out


def _page(page_id: int) -> list[str]:
    entry = (_get(f"static-pages/{page_id}").get("data") or {}).get("attributes") or {}
    return club_roster.paragraphs(entry.get("Text"))


def parse_awards(lines: list[str]) -> list[dict]:
    """Перечень наград со страницы «История»: заголовки капсом — группы."""
    groups, current = [], None
    started = False
    for line in lines:
        letters = re.sub(r"[^А-Яа-яЁёA-Za-z]", "", line)
        heading = letters and letters.upper() == letters and len(line) < 80
        if heading and "ПРИЗ" in line.upper() or heading and "ШЛЕМ" in line.upper():
            started = True
            current = {"title": line.strip().capitalize(), "items": []}
            groups.append(current)
            continue
        if not started or current is None:
            continue
        if line in ("Вратари", "Защитники", "Нападающие"):
            current["items"].append({"sub": line})
            continue
        current["items"].append({"text": line.strip()})
    return [g for g in groups if g["items"]]


def parse_legends(lines: list[str]) -> list[dict]:
    """Таблица «Известные игроки»: «Имя Фамилия ДД. ММ. ГГГГ» подряд.

    Строки таблицы склеены: позиция стоит в конце строки как заголовок
    следующей группы («…Вратари», «…Защитники», «…Нападающие»).
    """
    legends = []
    role = "вратарь"
    for line in lines:
        if not line.startswith("#Имя"):
            continue
        body = line.split("Страна", 1)[-1]
        for name, day, month, year in re.findall(
                r"([А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+)\s*(\d{2})\. (\d{2})\. (\d{4})", body):
            legends.append({"name": name, "birth": f"{year}-{month}-{day}", "role": role})
        tail = body.strip()
        role = ("защитник" if tail.endswith("Защитники") else
                "нападающий" if tail.endswith("Нападающие") else role)
    return legends


def fetch_archive(teams: list[dict] | None = None) -> list[dict]:
    """Все матчи основной команды с «Локомотивом» и счётом, с 2017/18."""
    rows, page = [], 1
    while True:
        payload = _get("games", {
            "filters[season][team][$eq]": "MEN",
            "filters[display_value][$containsi]": "Локомотив",
            "pagination[pageSize]": "100", "pagination[page]": str(page), "sort": "date:asc",
            "fields[0]": "date", "fields[1]": "score_1", "fields[2]": "score_2",
            "fields[3]": "display_value", "fields[4]": "period_scores",
            "populate[season][fields][0]": "years_interval", "populate[season][fields][1]": "name",
        })
        rows += payload.get("data") or []
        if page >= ((payload.get("meta") or {}).get("pagination") or {}).get("pageCount", 1):
            break
        page += 1

    games = []
    for item in rows:
        entry = item.get("attributes") or {}
        if entry.get("score_1") is None or entry.get("score_2") is None:
            continue
        teams_in_game = str(entry.get("display_value") or "").split(" - ")[0].split(":")
        if len(teams_in_game) != 2:
            continue
        season = club_roster._attrs(entry.get("season"))
        periods = [p for p in re.split(r"[;,]", entry.get("period_scores") or "") if p.strip()]
        home, away = teams_in_game[0].strip(), teams_in_game[1].strip()
        rival = away if home == "Локомотив" else home
        games.append({
            "date": str(entry.get("date") or "")[:10],
            "home": home, "away": away,
            "opp": _match_team(rival, teams),
            "score": f"{entry['score_1']}:{entry['score_2']}",
            "extra": len(periods) > 3,
            "stage": "playoff" if "гагарин" in (season.get("name") or "").lower()
                     else "pre" if "предсезон" in (season.get("name") or "").lower() else "regular",
            "season": season.get("years_interval"),
        })
    return games


def sync(teams: list[dict] | None = None, progress=print) -> dict:
    try:
        data = {
            "achievements": fetch_achievements(),
            "milestones": MILESTONES,
            "story": _page(PAGE_STORY),
            "awards": parse_awards(_page(PAGE_AWARDS)),
            "legends": parse_legends(_page(PAGE_LEGENDS)),
            "archive": fetch_archive(teams),
        }
    except Exception as error:
        progress(f"  история клуба: сайт клуба не ответил ({type(error).__name__}) — беру сохранённое")
        return load()
    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=0), encoding="utf-8")
    known = sum(1 for g in data["archive"] if g.get("opp"))
    progress(f"  история клуба: трофеев {len(data['achievements'])}, наград {sum(len(g['items']) for g in data['awards'])}, "
             f"легенд {len(data['legends'])}, матчей в архиве {len(data['archive'])} (соперник узнан у {known})")
    return data


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    import collect

    data = sync(collect.load().get("teams"))
    for item in data.get("achievements", []):
        print(" ", item["year"], item["kind"], item["title"])
    for group in data.get("awards", []):
        print("#", group["title"], len(group["items"]))
    for legend in data.get("legends", []):
        print(" ", legend)
