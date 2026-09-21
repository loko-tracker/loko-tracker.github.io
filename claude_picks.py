"""Прогнозы Claude — соперник в игре в прогнозы.

На каждый ещё не начавшийся матч Claude ставит счёт по той же модели, что
считает шансы на плей-офф (odds.py): ожидаемые голы каждой команды из силы
атаки и обороны плюс преимущество своего льда.

Победитель — тот, у кого выше шанс выиграть (с овертаймом и буллитами).
Счёт — сколько каждая команда должна забить по модели, округлённо; у
победителя минимум на шайбу больше. Чисто «самый выгодный по очкам» счёт
почти всегда выходил бы 3:2 — так честнее видно, как модель оценивает
именно этот матч. Ожидание очков по правилам игры (3/2/1) сохраняется
рядом для справки.

Прогноз пересчитывается каждое утро, пока матч не начался, а после начала
замораживается — так играть честно. Хранится в data/claude_picks.json.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import odds

DATA_FILE = Path(__file__).parent / "data" / "claude_picks.json"
MAX_GOALS = 10
PICK_RANGE = 8          # счета до 7 шайб — дальше вероятность ничтожна


def _poisson(lam: float) -> list[float]:
    probs, term = [], math.exp(-lam)
    for k in range(MAX_GOALS + 1):
        if k:
            term *= lam / k
        probs.append(term)
    return probs


def final_scores(lam_home: float, lam_away: float, ot_home: float) -> dict[tuple[int, int], float]:
    """Вероятности итоговых счетов: ничья в основное время решается
    одной шайбой в пользу хозяев с вероятностью ot_home."""
    home, away = _poisson(lam_home), _poisson(lam_away)
    out: dict[tuple[int, int], float] = {}
    for h, ph in enumerate(home):
        for a, pa in enumerate(away):
            p = ph * pa
            if h == a:
                out[(h + 1, a)] = out.get((h + 1, a), 0.0) + p * ot_home
                out[(h, a + 1)] = out.get((h, a + 1), 0.0) + p * (1 - ot_home)
            else:
                out[(h, a)] = out.get((h, a), 0.0) + p
    return out


def _points(pick: tuple[int, int], real: tuple[int, int]) -> int:
    if pick == real:
        return 3
    same = (pick[0] > pick[1]) == (real[0] > real[1])
    if same and pick[0] - pick[1] == real[0] - real[1]:
        return 2
    return 1 if same else 0


def expected_points(pick: tuple[int, int], dist: dict[tuple[int, int], float]) -> float:
    return sum(p * _points(pick, real) for real, p in dist.items())


def pick_score(lam_home: float, lam_away: float,
               dist: dict[tuple[int, int], float]) -> tuple[int, int]:
    """Фаворит по шансам на победу, счёт — по ожидаемым голам."""
    home_win = sum(p for (h, a), p in dist.items() if h > a)
    winner_lam, loser_lam = (lam_home, lam_away) if home_win >= 0.5 else (lam_away, lam_home)
    loser = min(PICK_RANGE - 2, int(loser_lam + 0.5))
    winner = min(PICK_RANGE - 1, max(int(winner_lam + 0.5), loser + 1))
    return (winner, loser) if home_win >= 0.5 else (loser, winner)


def _started(game: dict, now: dt.datetime) -> bool:
    if game.get("state") == "finished":
        return True
    try:
        return dt.datetime.fromisoformat(str(game.get("start_at"))) <= now
    except ValueError:
        return True


def update(season: dict, progress=print) -> dict:
    """Пересчитывает прогнозы на неначавшиеся матчи, начавшиеся не трогает."""
    picks = load()
    standings, games = season["standings"], season["games"]
    avg = odds.league_average(standings)
    home_adv = odds.home_advantage(games)
    ratings = odds.ratings(standings, avg)
    now = dt.datetime.now()
    stamp = now.date().isoformat()

    fresh = 0
    for game in games:
        home, away = game.get("home_id"), game.get("away_id")
        if _started(game, now) or home not in ratings or away not in ratings:
            continue
        lam_home = odds.expected_goals(ratings[home], ratings[away], avg) * home_adv
        lam_away = odds.expected_goals(ratings[away], ratings[home], avg)
        # Как в симуляции: в овертайме слабый перевес у более сильной атаки.
        ot_home = 0.54 if ratings[home][0] >= ratings[away][0] else 0.46
        dist = final_scores(lam_home, lam_away, ot_home)
        h, a = pick_score(lam_home, lam_away, dist)
        picks[str(game["id"])] = {"h": h, "a": a, "value": round(expected_points((h, a), dist), 3), "at": stamp}
        fresh += 1

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(picks, ensure_ascii=False, indent=0), encoding="utf-8")
    progress(f"  прогнозы Claude: обновлено {fresh}, всего {len(picks)}")
    return picks


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    import sys
    import collect

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    season = collect.load()
    picks = update(season)
    for game in season["games"]:
        if 26 in (game["home_id"], game["away_id"]) and str(game["id"]) in picks:
            pick = picks[str(game["id"])]
            print(game["start_at"][:10], game["home"], f"{pick['h']}:{pick['a']}", game["away"],
                  f"(в среднем {pick['value']} очка)")
            if game["start_at"] > "2026-10-05":
                break
