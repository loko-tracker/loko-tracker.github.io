"""Матч-центр «Локомотива»: кто забил, отчёт о матче и пресс-конференция.

В API лиги протокола матча нет — есть только счёт. Зато клуб выкладывает
у себя (api.hclokomotiv.ru) полный протокол каждой игры: голы с передачами,
броски, силовые приёмы, штраф, зрителей и судей. Там же лежат собственный
отчёт о матче и стенограмма послематчевой пресс-конференции.

Отчёт клуб публикует после каждой игры, пресс-конференцию — не всегда
(после выездных матчей её часто нет). Чего нет, того и не показываем.

Собранное хранится в data/club_games.json: если сайт клуба не ответит,
сайт покажет прошлый разбор, а не пустоту.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import urllib.parse
from pathlib import Path

import club_roster

DATA_FILE = Path(__file__).parent / "data" / "club_games.json"

SEASON = "2027MEN"
MSK = dt.timedelta(hours=3)             # в API клуба время в UTC
PRESSER_WINDOW = dt.timedelta(hours=9)  # пресс-конференция — вскоре после игры
PRESSER_MARK = "пресс-конференц"


# --------------------------------------------------------------- текст

paragraphs = club_roster.paragraphs


def _article(node) -> dict | None:
    data = club_roster._attrs(node)
    if not data.get("title"):
        return None
    return {
        "title": (data.get("title") or "").strip(),
        "lead": (data.get("annotation") or "").strip(),
        "date": data.get("date"),
        "text": paragraphs(data.get("full_text")),
    }


# --------------------------------------------------------------- протокол

def _as_list(node) -> list:
    if not node:
        return []
    return node if isinstance(node, list) else [node]


def _summary(protocol: dict) -> dict | None:
    raw = protocol.get("json")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    return raw.get("GameSummary")


def _person(text: str) -> dict:
    """«47.Радулов Александр(4)» -> номер, имя, счёт в сезоне."""
    match = re.match(r"\s*(\d+)?\.?\s*([^()]+?)\s*(?:\((\d+)\))?\s*$", text or "")
    if not match:
        return {"name": (text or "").strip()}
    number, name, season = match.groups()
    person = {"name": name.strip()}
    if number:
        person["number"] = int(number)
    if season:
        person["season"] = int(season)
    return person


def _side_totals(node, key: str) -> dict:
    """ShotsList/HitsList/BlsList -> {"A": 36, "B": 23}."""
    totals = {}
    for row in _as_list((node or {}).get(key)):
        team = row.get("@_team")
        if not team:
            continue
        total = 0
        for field in ("@_p1", "@_p2", "@_p3", "@_ot"):
            try:
                total += int(row.get(field) or 0)
            except (TypeError, ValueError):
                pass
        totals[team] = total
    return totals


def _penalty_totals(node) -> dict:
    totals = {}
    for team_block in _as_list(node):
        team = team_block.get("@_team")
        minutes = 0
        for penalty in _as_list(team_block.get("Penalty")):
            try:
                minutes += int(penalty.get("@_time") or 0)
            except (TypeError, ValueError):
                pass
        if team:
            totals[team] = minutes
    return totals


def _attack(node) -> dict:
    return {row.get("@_team"): row.get("@_summary")
            for row in _as_list((node or {}).get("Toa")) if row.get("@_team")}


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _goalies(summary: dict, mine_id) -> list[dict]:
    """Вратари из протокола: кто стоял, сколько бросков, сколько пропустил.

    Лига отдаёт по вратарям только число матчей, а клуб в протоколе —
    броски, сейвы и «сухари». Запасной, не выходивший на лёд, не нужен.
    """
    out = []
    for team in _as_list(summary.get("PlayerStatsList")):
        for row in _as_list(team.get("PlayerStats")):
            if (row.get("@_pos") or "").strip().lower() not in ("в", "g"):
                continue
            shots, goals = _int(row.get("@_sog")), _int(row.get("@_ga"))
            if not shots and not goals:
                continue
            out.append(
                {
                    "name": f"{row.get('@_lastname', '')} {row.get('@_firstname', '')}".strip(),
                    "number": _int(row.get("@_jn")) or None,
                    "mine": str(row.get("@_clubidt") or team.get("@_teamId")) == str(mine_id),
                    "shots": shots,
                    "saves": _int(row.get("@_sv")),
                    "goals": goals,
                    "shutout": _int(row.get("@_so")) > 0,
                }
            )
    return out


# Кого показывать из соперника: тех, кто набрал очки. Свой состав — весь,
# из него считается форма игроков.
def _lineup(summary: dict, mine_id) -> list[dict]:
    out = []
    for team in _as_list(summary.get("PlayerStatsList")):
        for row in _as_list(team.get("PlayerStats")):
            position = (row.get("@_pos") or "").strip().lower()
            if position in ("в", "g"):
                continue                        # вратари отдельно, в _goalies
            mine = str(row.get("@_clubidt") or team.get("@_teamId")) == str(mine_id)
            goals, assists = _int(row.get("@_g")), _int(row.get("@_a"))
            if not mine and not (goals or assists):
                continue
            out.append(
                {
                    "name": f"{row.get('@_lastname', '')} {row.get('@_firstname', '')}".strip(),
                    "number": _int(row.get("@_jn")) or None,
                    "mine": mine,
                    "pos": position,
                    "g": goals,
                    "a": assists,
                    "pm": _int(row.get("@_pm")),
                    "pim": _int(row.get("@_pim")),
                    "shots": _int(row.get("@_sog")),
                    "toi": row.get("@_toi_avg"),
                }
            )
    return out


def _protocol_data(summary: dict, home_is_mine: bool) -> dict:
    """Протокол -> голы и командные числа, всегда парой «мои : соперник»."""
    mine, theirs = ("A", "B") if home_is_mine else ("B", "A")
    mine_id = summary.get("@_homeId") if home_is_mine else summary.get("@_visitorId")

    goals = []
    for goal in _as_list((summary.get("Goals") or {}).get("Goal")):
        assists = [_person(goal[key]) for key in ("@_assist_1", "@_assist_2")
                   if goal.get(key)]
        goals.append(
            {
                "period": int(goal.get("@_per") or 0),
                "time": goal.get("@_time"),
                "score": goal.get("@_score"),
                "mine": str(goal.get("@_teamId")) == str(mine_id),
                "power_play": str(goal.get("@_pmg") or "0") == "1",
                "scorer": _person(goal.get("@_scorer")),
                "assists": assists,
            }
        )

    def pair(totals):
        if mine not in totals and theirs not in totals:
            return None
        return [totals.get(mine), totals.get(theirs)]

    stats = {
        "shots": pair(_side_totals(summary.get("ShotsList"), "Shot")),
        "blocked": pair(_side_totals(summary.get("BlsList"), "Bls")),
        "hits": pair(_side_totals(summary.get("HitsList"), "Hit")),
        "penalty": pair(_penalty_totals(summary.get("Penalties"))),
        "attack": pair(_attack(summary.get("TimeOnAttack"))),
    }
    return {
        "goals": goals,
        "goalies": _goalies(summary, mine_id),
        "lineup": _lineup(summary, mine_id),
        "stats": {k: v for k, v in stats.items() if v},
        "audience": summary.get("@_audience"),
        "coach_mine": summary.get("@_trainA" if home_is_mine else "@_trainB"),
        "coach_rival": summary.get("@_trainB" if home_is_mine else "@_trainA"),
        "referees": [summary.get("@_refm1"), summary.get("@_refm2")],
    }


# --------------------------------------------------------------- загрузка

def _get(path: str, params: dict):
    query = urllib.parse.urlencode(params, safe="[]$*:")
    return club_roster._get(f"{club_roster.LOKO_API}/{path}?{query}")


def fetch_games(season: str = SEASON) -> list[dict]:
    payload = _get(
        "games",
        {
            "sort": "date:asc",
            "filters[season][code][$eq]": season,
            "populate[protocol]": "*",
            "populate[article]": "*",
            "pagination[pageSize]": "120",
        },
    )
    return payload.get("data") or []


def fetch_pressers(season_start: str) -> list[dict]:
    payload = _get(
        "articles",
        {
            "sort": "date:asc",
            "filters[date][$gte]": season_start,
            "filters[title][$containsi]": PRESSER_MARK,
            "pagination[pageSize]": "200",
        },
    )
    return payload.get("data") or []


def _moment(value) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except (TypeError, ValueError):
        return None


def build(season: str = SEASON, progress=print) -> dict:
    """Собирает разбор каждого сыгранного матча, ключ — дата по Москве."""
    games = fetch_games(season)
    if not games:
        progress("  матч-центр: игр сезона у клуба нет — оставляю сохранённое")
        return load()

    start = min(filter(None, (_moment(g["attributes"].get("date")) for g in games)), default=None)
    pressers = fetch_pressers((start or dt.datetime.now()).date().isoformat())

    out = {}
    for item in games:
        entry = item.get("attributes") or {}
        when = _moment(entry.get("date"))
        summary = _summary(club_roster._attrs(entry.get("protocol")))
        if not when or not summary:
            continue                            # матч ещё не сыгран

        # «Локомотив : Барыс» — хозяева слева, как и в протоколе.
        home_is_mine = str(entry.get("display_value", "")).split(":")[0].strip().startswith("Локомотив")
        match = _protocol_data(summary, home_is_mine)
        match["report"] = _article(entry.get("article"))
        match["arena"] = entry.get("stadium")

        for presser in pressers:
            said = presser.get("attributes") or {}
            moment = _moment(said.get("date"))
            if moment and when <= moment <= when + PRESSER_WINDOW:
                match["presser"] = _article({"data": {"attributes": said}})
                break

        out[(when + MSK).date().isoformat()] = match

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    talks = sum(1 for m in out.values() if m.get("presser"))
    progress(f"  матч-центр: разобрано матчей {len(out)}, с пресс-конференцией {talks}")
    return out


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    data = build()
    for day, match in data.items():
        line = ", ".join(
            f"{g['score']} {g['scorer']['name']}" for g in match["goals"]
        )
        print(day, "|", line[:90])
        print("   отчёт:", (match.get("report") or {}).get("title"),
              "| пресс:", (match.get("presser") or {}).get("title"))
