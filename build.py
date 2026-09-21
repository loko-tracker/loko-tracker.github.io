"""Готовит data/site_data.json — единственный файл, который читает страница.

Сюда стекается всё: таблица из API, посчитанные шансы на плей-офф,
календарь с результатами, лидеры по личной статистике и лазарет.
Страница ничего не вычисляет, только отображает.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import club_games
import club_news
import club_roster
import collect
import injuries as injuries_module
import memorial
import odds as odds_module

DATA = Path(__file__).parent / "data"
SITE_DATA = DATA / "site_data.json"
SITE_CONFIG = Path(__file__).parent / "site.json"

LEADER_LIMIT = 40


def _leaders(players: list[dict], field: str, *, limit: int = LEADER_LIMIT,
             min_games: int = 1, reverse: bool = True) -> list[dict]:
    pool = [p for p in players if p.get("gp", 0) >= min_games]
    pool.sort(
        key=lambda p: (p.get(field) or 0, p.get("pts") or 0, -(p.get("gp") or 0)),
        reverse=reverse,
    )
    return [
        {
            "id": p["id"],
            "name": p["name"],
            "team": p["team"],
            "team_id": p["team_id"],
            "role": p.get("role"),
            "number": p.get("number"),
            "gp": p.get("gp"),
            "g": p.get("g"),
            "a": p.get("a"),
            "pts": p.get("pts"),
            "pim": p.get("pim"),
            "plus_minus": p.get("plus_minus"),
            "toi_avg": p.get("toi_avg"),
            "top_speed": p.get("top_speed"),
            "value": p.get(field),
        }
        for p in pool[:limit]
    ]


def watch_links() -> dict:
    """Ссылки «Смотреть» из site.json: трансляции идут у правообладателя."""
    try:
        config = json.loads(SITE_CONFIG.read_text(encoding="utf-8")).get("watch") or {}
    except (OSError, json.JSONDecodeError):
        return {}
    return {key: config[key] for key in ("team", "league", "khl_stage") if config.get(key)}


def my_team_id(teams: list[dict]) -> int | None:
    """Клуб, который сайт показывает первым. Задаётся названием в site.json."""
    try:
        name = json.loads(SITE_CONFIG.read_text(encoding="utf-8")).get("my_team")
    except (OSError, json.JSONDecodeError):
        return None
    if not name:
        return None
    wanted = name.strip().lower()
    for team in teams:
        if (team.get("name") or "").strip().lower() == wanted:
            return team["id"]
    return None


def build(season: dict | None = None, *, sims: int = 10_000, progress=print) -> dict:
    season = season or collect.load()

    progress(f"Шансы на плей-офф: {sims} симуляций…")
    odds = odds_module.simulate(
        season,
        sims=sims,
        progress=lambda i, n: progress(f"  {i}/{n}"),
    )
    odds_by_team = {row["team_id"]: row for row in odds["teams"]}

    # Таблица: складываем строки API и результат симуляции в один объект,
    # раскладываем по конференциям и сортируем по регламенту КХЛ —
    # очки, затем победы, затем разница шайб.
    conferences: dict[str, list[dict]] = {"west": [], "east": []}
    for row in season["standings"]:
        forecast = odds_by_team.get(row["team_id"], {})
        enriched = {
            **row,
            "diff": row["gf"] - row["ga"],
            "gf_pg": round(row["gf"] / row["gp"], 2) if row["gp"] else 0,
            "ga_pg": round(row["ga"] / row["gp"], 2) if row["gp"] else 0,
            "playoff_pct": round(forecast.get("playoff_pct", 0), 1),
            "conf_first_pct": round(forecast.get("conf_first_pct", 0), 1),
            "continental_pct": round(forecast.get("continental_pct", 0), 1),
            "proj_pts": round(forecast.get("proj_pts", 0), 1),
            "proj_pts_low": forecast.get("proj_pts_low"),
            "proj_pts_high": forecast.get("proj_pts_high"),
            "proj_pts_median": forecast.get("proj_pts_median"),
        }
        key = row.get("conference_key") or "west"
        conferences.setdefault(key, []).append(enriched)

    for rows in conferences.values():
        rows.sort(
            key=lambda r: (r["pts"], r["w"] + r["otw"] + r["sow"], r["diff"]),
            reverse=True,
        )
        for index, row in enumerate(rows, start=1):
            row["position"] = index
            row["in_playoff_zone"] = index <= odds_module.PLAYOFF_SPOTS

    games = season["games"]
    played = [g for g in games if g.get("state") == "finished"]
    upcoming = [g for g in games if g.get("state") != "finished"]

    now = dt.datetime.now().isoformat(timespec="seconds")
    injuries_data = injuries_module.load()

    payload = {
        "built_at": now,
        "fetched_at": season.get("fetched_at"),
        "season": "2026/2027",
        "summary": {
            "teams": len(season["teams"]),
            "games_total": len(games),
            "games_played": len(played),
            "games_left": len(upcoming),
            "season_start": games[0]["start_at"] if games else None,
            "season_end": games[-1]["start_at"] if games else None,
            "last_game_at": played[-1]["start_at"] if played else None,
            "next_game_at": upcoming[0]["start_at"] if upcoming else None,
            "players": len(season["players"]),
        },
        "teams": season["teams"],
        "standings": conferences,
        "odds": {
            "sims": odds["sims"],
            "league_avg_goals": round(odds["league_avg_goals"], 3),
            "home_advantage": round(odds["home_advantage"], 4),
            "prior_games": odds["prior_games"],
            "games_remaining": odds["games_remaining"],
            "lines": odds["lines"],
            "matchups": odds["matchups"],
            "teams": [
                {
                    **row,
                    "playoff_pct": round(row["playoff_pct"], 1),
                    "conf_first_pct": round(row["conf_first_pct"], 1),
                    "continental_pct": round(row["continental_pct"], 1),
                    "proj_pts": round(row["proj_pts"], 1),
                    "attack": round(row["attack"], 2),
                    "defence": round(row["defence"], 2),
                }
                for row in odds["teams"]
            ],
        },
        "games": games,
        "players": season["players"],
        "leaders": {
            "pts": _leaders(season["players"], "pts"),
            "g": _leaders(season["players"], "g"),
            "a": _leaders(season["players"], "a"),
            "plus_minus": _leaders(season["players"], "plus_minus", min_games=3),
            "top_speed": _leaders(season["players"], "top_speed", min_games=2),
            "pim": _leaders(season["players"], "pim"),
        },
        # Травмы по данным самих клубов — первыми: они надёжнее новостей.
        "injuries": season.get("club_injuries", []) + injuries_module.merged(injuries_data),
        "my_team_id": my_team_id(season["teams"]),
        "watch": watch_links(),
        # Ссылки на сайт клуба странице не нужны — только имена скачанных фото.
        "club_rosters": {
            team: [{k: v for k, v in m.items() if not k.endswith("_url")} for m in roster]
            for team, roster in season.get("club_rosters", {}).items()
        },
        "club_facts": {str(team): facts for team, facts in club_roster.FACTS.items()},
        "memorial": memorial.payload(),
        "club_games": club_games.load(),
        "club_news": club_news.load(),
        "injuries_updated_at": injuries_data.get("updated_at"),
    }

    return payload


def save(payload: dict) -> Path:
    DATA.mkdir(exist_ok=True)
    SITE_DATA.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return SITE_DATA


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    path = save(build(sims=4000))
    size = path.stat().st_size / 1024
    print(f"\nГотово: {path} ({size:.0f} КБ)")
