"""Составы всех клубов КХЛ — из заявок, а не из статистики.

`players_v2.json` отдаёт только тех, кто уже выходил на лёд, поэтому в
начале сезона состав любого клуба выглядит полупустым: у «Локомотива»
из 27 заявленных там было 20. А `team_v2.json?id=<клуб>` отдаёт заявку
целиком — с номерами, амплуа, портретами и главным тренером.

Отсюда же берутся адреса фотографий: их отдаёт khl.ru, и в данные
попадает ссылка, а не копия. Портреты лига хранит у себя, и пусть
хранит — мы только показываем.

У «Локомотива» состав остаётся со своего сайта (club_roster.py): там
и биографии, и снимки с матчей, и отметки о травмах. Этот модуль
достраивает остальные клубы.

Собранное лежит в data/league_rosters.json: если API не ответит,
останется прежнее.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import club_roster
import collect
import khl_api

DATA_FILE = Path(__file__).parent / "data" / "league_rosters.json"

PLAYER_PAGE = "https://www.khl.ru/players/{khl_id}/"

# Портрет отдаётся с переадресацией на этот адрес — идём сразу туда,
# иначе браузер делает лишний запрос на каждое лицо в составе.
FACE = re.compile(r"^https?://(?:www\.)?khl\.ru/img/teamplayers_db/(\d+)/(\d+)\.jpg$", re.I)
FACE_DIRECT = "https://img.khl.ru/teamplayers/{team}/{player}/320.jpg"


def _face(url: str | None) -> str | None:
    match = FACE.match(url or "")
    return FACE_DIRECT.format(team=match.group(1), player=match.group(2)) if match else (url or None)


def _player(entry: dict) -> dict | None:
    name = (entry.get("name") or "").strip()
    if not name:
        return None
    role_key = collect.role_key(entry.get("role_key")) or "forward"
    return {
        "name": name,
        "number": entry.get("shirt_number"),
        "role_key": role_key,
        "role": club_roster.ROLES.get(role_key, ""),
        "photo": _face(entry.get("image")),
        "url": PLAYER_PAGE.format(khl_id=entry["khl_id"]) if entry.get("khl_id") else None,
        "country": (entry.get("country") or "").strip() or None,
    }


def fetch_team(team_id: int) -> dict:
    team = khl_api.fetch_json("team_v2.json", {"id": team_id}).get("team") or {}
    players = [p for p in (_player(x) for x in team.get("players") or ()) if p]
    coach = team.get("head_coach") or {}
    return {
        "players": players,
        "coach": {"name": (coach.get("name") or "").strip() or None,
                  "photo": coach.get("photo") or None},
    }


def sync(teams: list[dict], progress=print) -> dict:
    rosters, failed = {}, 0
    for team in teams or ():
        team_id = team.get("id")
        if team_id is None:
            continue
        try:
            rosters[str(team_id)] = fetch_team(team_id)
        except Exception:
            failed += 1                       # один клуб не ответил — не беда
    if not rosters:
        progress("  составы клубов: API не ответил — беру сохранённые")
        return load()

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(rosters, ensure_ascii=False, indent=0), encoding="utf-8")
    total = sum(len(r["players"]) for r in rosters.values())
    faces = sum(1 for r in rosters.values() for p in r["players"] if p["photo"])
    note = f", не ответили: {failed}" if failed else ""
    progress(f"  составы клубов: {len(rosters)} клубов, {total} игроков, с фото {faces}{note}")
    return rosters


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def apply(season_data: dict, rosters: dict, progress=print) -> dict:
    """Достраивает состав каждого клуба до заявки.

    Игроки из заявки, которые ещё не выходили на лёд, добавляются с
    нулями — так в составе видно всех. Клубы, состав которых уже взят
    с их собственного сайта, не трогаем.
    """
    players = season_data.get("players") or []
    teams = {t["id"]: t for t in season_data.get("teams") or []}
    known = season_data.setdefault("club_rosters", {})

    by_key: dict[str, list[dict]] = {}
    for player in players:
        by_key.setdefault(club_roster._api_key(player.get("name")), []).append(player)

    added = 0
    for team_key, roster in (rosters or {}).items():
        if team_key in known:                 # «Локомотив» — со своего сайта
            continue
        team_id = int(team_key)
        team = teams.get(team_id, {})
        for member in roster.get("players") or ():
            key = club_roster._api_key(member["name"])
            stats = next((p for p in by_key.get(key, []) if p.get("team_id") == team_id), None)
            if stats is None:
                stats = next((p for p in by_key.get(key, []) if not p.get("team_id")), None)
            if stats is None:
                stats = {
                    "id": f"roster-{team_id}-{member['number']}-{member['name']}",
                    "gp": 0, "g": 0, "a": 0, "pts": 0, "pim": 0,
                    "plus_minus": 0, "toi_avg": 0, "top_speed": 0,
                }
                players.append(stats)
                added += 1
            stats.update(
                {
                    "name": member["name"],
                    "team_id": team_id,
                    "team": team.get("name") or stats.get("team", ""),
                    "conference": team.get("conference", stats.get("conference", "")),
                    "number": member["number"] if member["number"] is not None else stats.get("number"),
                    "role_key": member["role_key"] or stats.get("role_key") or "forward",
                    "in_roster": True,
                }
            )
            stats["role"] = club_roster.ROLES.get(stats["role_key"], stats.get("role") or "")
        known[team_key] = roster["players"]

    season_data["players"] = players
    progress(f"  заявки клубов: добавлено игроков без матчей — {added}")
    return season_data


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    import collect

    season = collect.load()
    data = sync(season.get("teams") or [])
    for team_id, roster in list(data.items())[:3]:
        print(team_id, len(roster["players"]), roster["coach"]["name"])
