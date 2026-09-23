"""Забирает всё нужное из API КХЛ и складывает в data/season.json.

Нормализует сырые ответы в плоскую структуру, с которой дальше работают
odds.py и build.py: они про сеть ничего не знают и читают только файл.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import clock
import khl_api

DATA = Path(__file__).parent / "data"
SEASON_FILE = DATA / "season.json"

# Регулярный чемпионат 2026/2027. Меняется раз в сезон — при смене сезона
# достаточно поправить здесь: stage_name в ответе API служит проверкой.
STAGE_ID = 407

# КХЛ считает по двухочковой системе: победа в любой форме — 2, поражение
# в овертайме или по буллитам — 1, поражение в основное время — 0.
# Проверено на таблице: сумма всегда совпадает с pts из API.
PTS_WIN = 2
PTS_OT_LOSS = 1


def _iso(ms: int | None) -> str | None:
    if not ms:
        return None
    return clock.from_unix(ms / 1000).isoformat(timespec="seconds")


# Амплуа защитника лига пишет то в единственном числе, то во множественном;
# из-за разнобоя такие игроки выпадали из состава на странице клуба.
ROLE_KEYS = {"defensemen": "defenseman", "defenceman": "defenseman"}


def role_key(value: str | None) -> str | None:
    return ROLE_KEYS.get(value, value)


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _conference_key(name: str | None) -> str:
    """«Конференция «Запад»» -> west."""
    if not name:
        return ""
    return "west" if "Запад" in name else "east" if "Восток" in name else ""


def _short_conference(name: str | None) -> str:
    return "Запад" if _conference_key(name) == "west" else "Восток" if name else ""


CURRENT_SEASON = "2026/2027"


def _current_team(player: dict) -> dict:
    """Клуб игрока в текущем сезоне.

    У заметной части игроков (около 15%) API оставляет поле team пустым,
    хотя карьера по клубам лежит рядом в teams — с перечнем сезонов у
    каждого клуба. Раньше такие игроки выпадали из составов: сайт смотрел
    только на team. Теперь, если team пуст, берём клуб, у которого среди
    сезонов есть текущий.
    """
    team = player.get("team")
    if team:
        return team
    for entry in player.get("teams") or ():
        seasons = [s.strip() for s in (entry.get("seasons") or "").split(",")]
        if CURRENT_SEASON in seasons:
            return entry
    return {}


def _birthday(value) -> str | None:
    """Дата рождения приходит секундами Unix (полночь по UTC)."""
    try:
        return dt.datetime.fromtimestamp(int(value), dt.timezone.utc).date().isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _stat(player: dict, stat_id: str, default=0):
    for entry in player.get("stats") or ():
        if entry.get("id") == stat_id:
            value = entry.get("val")
            return default if value is None else value
    return default


def collect(progress=print) -> dict:
    progress("Клубы…")
    raw_teams = khl_api.teams()
    teams = [
        {
            "id": t["id"],
            "khl_id": t.get("khl_id"),
            "name": t.get("name"),
            "location": t.get("location"),
            "conference": _short_conference(t.get("conference")),
            "conference_key": _conference_key(t.get("conference")),
            "division": (t.get("division") or "").replace("Дивизион ", ""),
            "image": t.get("image"),
        }
        for t in raw_teams
    ]
    progress(f"  клубов: {len(teams)}")

    progress("Таблица…")
    raw_tables = khl_api.tables()
    standings = []
    for wrapper in raw_tables.get("regular") or ():
        t = wrapper.get("team") or {}
        coach = (t.get("head_coach") or {}).get("name") or ""
        row = {
            "team_id": t.get("id"),
            "name": t.get("name"),
            "conference": _short_conference(t.get("conference")),
            "conference_key": _conference_key(t.get("conference")),
            "division": (t.get("division") or "").replace("Дивизион ", ""),
            "coach": coach,
            "image": t.get("image"),
            "gp": _int(t.get("gp")),
            "w": _int(t.get("w")),
            "otw": _int(t.get("otw")),
            "sow": _int(t.get("sow")),
            "sol": _int(t.get("sol")),
            "otl": _int(t.get("otl")),
            "l": _int(t.get("l")),
            "pts": _int(t.get("pts")),
            "gf": _int(t.get("gf")),
            "ga": _int(t.get("ga")),
        }
        # Сверяем очки с двухочковой системой: если API когда-нибудь
        # сменит формулу, это всплывёт сразу, а не тихо испортит прогноз.
        expected = PTS_WIN * (row["w"] + row["otw"] + row["sow"]) + PTS_OT_LOSS * (row["sol"] + row["otl"])
        row["pts_check_ok"] = expected == row["pts"]
        standings.append(row)
    bad = [r["name"] for r in standings if not r["pts_check_ok"]]
    if bad:
        progress(f"  ВНИМАНИЕ: очки не сходятся у {', '.join(bad)} — проверь систему начисления")
    progress(f"  строк: {len(standings)}")

    progress("Матчи (листаю страницами)…")
    raw_events = khl_api.events(
        progress=lambda page, total, fresh: progress(f"  стр. {page}: всего {total}")
    )
    # В одном городе бывает несколько клубов (в Москве их три), поэтому
    # город -> множество id, а не один id.
    by_location: dict[str, set[int]] = {}
    for t in teams:
        if t.get("location"):
            by_location.setdefault(t["location"], set()).add(t["id"])

    games, home_guess_misses = [], 0
    for e in raw_events:
        a, b = e.get("team_a") or {}, e.get("team_b") or {}
        # team_a — хозяева: у проверенных матчей город события совпадает
        # с городом team_a. Считаем расхождения, чтобы знать, если
        # допущение перестанет работать (нейтральные арены, переносы).
        hosts = by_location.get(e.get("location") or "")
        if hosts and a.get("id") not in hosts:
            home_guess_misses += 1
        scores = e.get("scores") or {}
        games.append(
            {
                "id": e.get("id"),
                "match_id": e.get("match_id") or e.get("khl_id"),
                "start_at": _iso(e.get("start_at")),
                "state": e.get("game_state_key"),
                "home_id": a.get("id"),
                "home": a.get("name"),
                "home_image": a.get("image"),
                "away_id": b.get("id"),
                "away": b.get("name"),
                "away_image": b.get("image"),
                "score": e.get("score"),
                "periods": {
                    "p1": scores.get("first_period"),
                    "p2": scores.get("second_period"),
                    "p3": scores.get("third_period"),
                    "ot": scores.get("overtime"),
                    "so": scores.get("bullitt"),
                },
                "location": e.get("location"),
            }
        )
    games.sort(key=lambda g: g["start_at"] or "")
    finished = sum(1 for g in games if g["state"] == "finished")
    progress(f"  матчей: {len(games)} (сыграно {finished}, впереди {len(games) - finished})")
    if home_guess_misses:
        progress(f"  примечание: у {home_guess_misses} матчей город не совпал с хозяевами")

    progress("Игроки (это самая длинная часть)…")
    raw_players = khl_api.players(
        STAGE_ID,
        progress=lambda page, total, fresh: (
            progress(f"  стр. {page}: всего {total}") if page % 5 == 0 or fresh == 0 else None
        ),
    )
    # Конференцию берём из справочника клубов: в истории карьеры её нет.
    conference_by_team = {t["id"]: t["conference"] for t in teams}

    players, recovered, skipped = [], 0, 0
    for p in raw_players:
        team = _current_team(p)
        if team and not p.get("team"):
            recovered += 1

        gp = _int(_stat(p, "gp"))
        # Без клуба в текущем сезоне и без единого матча — это не чей-то
        # состав, а хвост прошлых лет. В списках он только путал бы.
        if not team and gp == 0:
            skipped += 1
            continue

        players.append(
            {
                "id": p.get("id"),
                "name": p.get("name"),
                "team_id": team.get("id"),
                "team": team.get("name"),
                "conference": conference_by_team.get(team.get("id"))
                              or _short_conference(team.get("conference")),
                "role": p.get("role"),
                "role_key": role_key(p.get("role_key")),
                "number": p.get("shirt_number"),
                "age": p.get("age"),
                "country": p.get("country"),
                "image": p.get("image"),
                "birthday": _birthday(p.get("birthday")),
                "height": p.get("height") or None,
                "weight": p.get("weight") or None,
                "stick": {"l": "левый", "r": "правый"}.get(str(p.get("stick") or "").lower()),
                "gp": _int(_stat(p, "gp")),
                "g": _int(_stat(p, "g")),
                "a": _int(_stat(p, "a")),
                "pts": _int(_stat(p, "pts")),
                "pim": _int(_stat(p, "pim")),
                "plus_minus": _int(_stat(p, "pm")),
                "toi_avg": round(float(_stat(p, "toi_avg", 0.0) or 0), 1),
                "top_speed": round(float(_stat(p, "top_speed", 0.0) or 0), 1),
            }
        )
    progress(f"  игроков: {len(players)} (клуб восстановлен по истории карьеры: {recovered}, "
             f"без клуба и без матчей в сезоне пропущено: {skipped})")

    season = {
        "fetched_at": clock.stamp(),
        "stage_id": STAGE_ID,
        "teams": teams,
        "standings": standings,
        "games": games,
        "players": players,
    }
    return season


def save(season: dict) -> Path:
    DATA.mkdir(exist_ok=True)
    SEASON_FILE.write_text(
        json.dumps(season, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return SEASON_FILE


def load() -> dict:
    if not SEASON_FILE.exists():
        raise SystemExit(
            f"нет файла {SEASON_FILE}. Запусти сначала сбор: python run.py"
        )
    return json.loads(SEASON_FILE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    path = save(collect())
    print(f"\nГотово: {path}")
