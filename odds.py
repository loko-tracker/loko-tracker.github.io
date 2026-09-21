"""Шансы на плей-офф методом Монте-Карло.

Готового источника вероятностей для КХЛ не существует, поэтому считаем сами:
оцениваем силу атаки и обороны каждого клуба, прогоняем весь остаток
календаря много раз и смотрим, как часто команда оказывается в топ-8
своей конференции.

Главная ловушка — ранний сезон. После пяти матчей разница «забил 17 против
забил 8» почти целиком случайность, и модель, принявшая её за силу, выдаст
уверенную чушь. Поэтому рейтинги стягиваются к среднему по лиге с весом
PRIOR_GAMES: в сентябре прогноз близок к «все равны», к февралю опирается
почти только на факты.
"""

from __future__ import annotations

import bisect
import math
import random
from collections import defaultdict

# Сколько «виртуальных средних матчей» подмешивается к статистике клуба.
# 12 подобрано так, чтобы на старте сезона (4-6 игр) фактические данные
# весили меньше половины, а после 30 игр — доминировали.
PRIOR_GAMES = 12

# Преимущество своего поля как множитель к ожидаемым голам. Считается по
# фактически сыгранным матчам, но стягивается к этому значению, пока
# выборка мала.
HOME_ADV_PRIOR = 1.06
HOME_ADV_PRIOR_WEIGHT = 120      # в матчах

PTS_WIN = 2
PTS_OT_LOSS = 1
PLAYOFF_SPOTS = 8

MAX_GOALS = 12                   # обрезка хвоста Пуассона для таблиц


# ----------------------------------------------------------------- рейтинги

def _parse_score(score: str | None) -> tuple[int, int] | None:
    if not score or ":" not in score:
        return None
    left, _, right = score.partition(":")
    try:
        return int(left.strip()), int(right.strip())
    except ValueError:
        return None


def league_average(standings: list[dict]) -> float:
    """Средняя результативность одной команды за матч."""
    games = sum(r["gp"] for r in standings)
    goals = sum(r["gf"] for r in standings)
    if not games or not goals:
        return 2.7                     # разумное значение до старта сезона
    return goals / games


def home_advantage(games: list[dict]) -> float:
    """Множитель домашних голов, оценённый по сыгранным матчам."""
    home_goals = away_goals = played = 0
    for g in games:
        if g.get("state") != "finished":
            continue
        parsed = _parse_score(g.get("score"))
        if not parsed:
            continue
        home_goals += parsed[0]
        away_goals += parsed[1]
        played += 1
    if not played or not away_goals:
        return HOME_ADV_PRIOR
    observed = home_goals / away_goals
    # стягиваем к априорному, пока матчей мало
    weight = played / (played + HOME_ADV_PRIOR_WEIGHT)
    return HOME_ADV_PRIOR * (1 - weight) + observed * weight


def ratings(standings: list[dict], avg: float) -> dict[int, tuple[float, float, float]]:
    """team_id -> (атака, оборона, погрешность) в голах за матч.

    Первые два числа — оценка, стянутая к среднему по лиге. Третье — насколько
    мы этой оценке не доверяем. Погрешность падает как корень из числа
    наблюдений: после пяти матчей она около 0.4 гола за игру, к февралю
    примерно вдвое меньше.
    """
    out = {}
    for row in standings:
        observations = row["gp"] + PRIOR_GAMES
        attack = (row["gf"] + PRIOR_GAMES * avg) / observations
        defence = (row["ga"] + PRIOR_GAMES * avg) / observations
        error = math.sqrt(max(attack, 0.5) / observations)
        out[row["team_id"]] = (attack, defence, error)
    return out


def expected_goals(rating_a, rating_b, avg: float) -> float:
    """Ожидаемые голы A против B: своя атака × чужая оборона / средняя."""
    attack = rating_a[0]
    opponent_defence = rating_b[1]
    return max(0.25, attack * opponent_defence / avg)


# ------------------------------------------------------- розыгрыш по Пуассону

def _poisson_cdf(lam: float) -> list[float]:
    """Накопленные вероятности 0..MAX_GOALS для розыгрыша через bisect."""
    cdf, total, term = [], 0.0, math.exp(-lam)
    for k in range(MAX_GOALS + 1):
        if k:
            term *= lam / k
        total += term
        cdf.append(total)
    cdf[-1] = 1.0                    # хвост сваливаем в последний исход
    return cdf


class _GoalSampler:
    """Кэш таблиц Пуассона: одна на каждое значение λ, округлённое до шага.

    Без кэша 10 000 симуляций × 700 матчей × 2 команды пересчитывали бы
    экспоненту 14 млн раз. С ним остаётся два random() и два bisect.
    Округление до 0.05 держит число таблиц в пределах сотен, а на
    вероятностях сказывается меньше, чем шум самих симуляций.
    """

    STEP = 20            # 1/0.05

    def __init__(self):
        self._tables: dict[int, list[float]] = {}

    def table(self, lam: float) -> list[float]:
        key = int(lam * self.STEP + 0.5)
        table = self._tables.get(key)
        if table is None:
            table = _poisson_cdf(key / self.STEP)
            self._tables[key] = table
        return table


# ------------------------------------------------------------------ симуляция

def simulate(season: dict, sims: int = 10_000, seed: int | None = 20262027,
             progress=None) -> dict:
    standings = season["standings"]
    games = season["games"]

    avg = league_average(standings)
    home_adv = home_advantage(games)
    team_ratings = ratings(standings, avg)

    conference = {r["team_id"]: r["conference_key"] for r in standings}
    names = {r["team_id"]: r["name"] for r in standings}

    # Стартовая точка: уже набранные очки, победы и разница шайб.
    base = {
        r["team_id"]: (
            r["pts"],
            r["w"] + r["otw"] + r["sow"],
            r["gf"] - r["ga"],
        )
        for r in standings
    }

    remaining = [
        g for g in games
        if g.get("state") != "finished"
        and g.get("home_id") in team_ratings
        and g.get("away_id") in team_ratings
    ]

    sampler = _GoalSampler()
    fixtures = [(g["home_id"], g["away_id"]) for g in remaining]
    # Уникальные пары: матчи повторяются, и таблицы для пары достаточно
    # построить один раз за прогон, а не на каждый матч.
    unique_pairs = list({pair for pair in fixtures})
    team_ids = list(team_ratings.keys())

    by_conference: dict[str, list[int]] = defaultdict(list)
    for team_id, key in conference.items():
        by_conference[key].append(team_id)

    playoff_hits = defaultdict(int)
    first_hits = defaultdict(int)
    continental_hits = defaultdict(int)
    # Храним все исходы, чтобы потом взять не крайние значения, а интервал:
    # минимум и максимум из десяти тысяч прогонов — это единичные выбросы,
    # они выглядят внушительно и ничего не сообщают.
    points_runs: dict[int, list[int]] = {t: [] for t in team_ratings}
    # Сколько очков в каждом прогоне набрали восьмое и первое место
    # конференции — из этого считается «что нужно» для плей-офф и первого места.
    line_runs: dict[str, dict[str, list[int]]] = {
        key: {"playoff": [], "first": []} for key in by_conference
    }
    # Исходы каждого оставшегося матча: победа хозяев в основное время,
    # в овертайме/по буллитам, то же для гостей. Для превью матча.
    outcome_counts = [[0, 0, 0, 0] for _ in fixtures]

    rng = random.Random(seed)
    rand = rng.random
    gauss = rng.gauss
    table_of = sampler.table
    bisect_left = bisect.bisect_left

    for run in range(sims):
        # На каждом прогоне заново выбираем «настоящую» силу команд в
        # пределах нашей неуверенности. Без этого шага модель считала бы
        # оценку по пяти матчам точной и выдавала 100% там, где о клубе
        # ещё почти ничего не известно.
        drawn = {}
        for team_id in team_ids:
            attack, defence, error = team_ratings[team_id]
            drawn[team_id] = (
                max(0.7, gauss(attack, error)),
                max(0.7, gauss(defence, error)),
            )

        pair_tables = {}
        for pair in unique_pairs:
            home, away = pair
            lam_home = expected_goals(drawn[home], drawn[away], avg) * home_adv
            lam_away = expected_goals(drawn[away], drawn[home], avg)
            pair_tables[pair] = (table_of(lam_home), table_of(lam_away))

        pts = {t: base[t][0] for t in team_ratings}
        wins = {t: base[t][1] for t in team_ratings}
        diff = {t: base[t][2] for t in team_ratings}

        for index, pair in enumerate(fixtures):
            home, away = pair
            table_home, table_away = pair_tables[pair]
            gh = bisect_left(table_home, rand())
            ga = bisect_left(table_away, rand())
            counts = outcome_counts[index]

            if gh == ga:
                # Овертайм и буллиты: победителя определяем броском монеты
                # со слабым перевесом в сторону более сильной атаки.
                edge = 0.5 + 0.04 * (1 if drawn[home][0] >= drawn[away][0] else -1)
                if rand() < edge:
                    pts[home] += PTS_WIN
                    pts[away] += PTS_OT_LOSS
                    wins[home] += 1
                    gh += 1
                    counts[1] += 1
                else:
                    pts[away] += PTS_WIN
                    pts[home] += PTS_OT_LOSS
                    wins[away] += 1
                    ga += 1
                    counts[2] += 1
            elif gh > ga:
                pts[home] += PTS_WIN
                wins[home] += 1
                counts[0] += 1
            else:
                pts[away] += PTS_WIN
                wins[away] += 1
                counts[3] += 1

            diff[home] += gh - ga
            diff[away] += ga - gh

        for team_id in points_runs:
            points_runs[team_id].append(pts[team_id])

        # Регламент КХЛ ранжирует по очкам, затем победам, затем разнице шайб
        # (личные встречи здесь не воспроизводим — на вероятностях топ-8
        # это почти не сказывается).
        best_overall, best_key = None, None
        # Имя conf_teams, а не team_ids: одноимённая переменная выше хранит
        # все 22 клуба, и перекрыть её здесь значило бы потерять половину
        # команд на следующем прогоне.
        for key, conf_teams in by_conference.items():
            table = sorted(
                conf_teams,
                key=lambda t: (pts[t], wins[t], diff[t]),
                reverse=True,
            )
            for team_id in table[:PLAYOFF_SPOTS]:
                playoff_hits[team_id] += 1
            first_hits[table[0]] += 1
            line_runs[key]["first"].append(pts[table[0]])
            line_runs[key]["playoff"].append(pts[table[min(PLAYOFF_SPOTS, len(table)) - 1]])
            leader_key = (pts[table[0]], wins[table[0]], diff[table[0]])
            if best_key is None or leader_key > best_key:
                best_key, best_overall = leader_key, table[0]
        continental_hits[best_overall] += 1

        if progress and sims >= 20 and (run + 1) % max(1, sims // 10) == 0:
            progress(run + 1, sims)

    def percentile(sorted_values: list[int], share: float) -> int:
        if not sorted_values:
            return 0
        index = min(len(sorted_values) - 1, max(0, int(share * len(sorted_values))))
        return sorted_values[index]

    results = []
    for row in standings:
        team_id = row["team_id"]
        runs = sorted(points_runs[team_id])
        results.append(
            {
                "team_id": team_id,
                "name": names[team_id],
                "conference": row["conference"],
                "conference_key": row["conference_key"],
                "pts": row["pts"],
                "gp": row["gp"],
                "playoff_pct": 100.0 * playoff_hits[team_id] / sims,
                "conf_first_pct": 100.0 * first_hits[team_id] / sims,
                "continental_pct": 100.0 * continental_hits[team_id] / sims,
                "proj_pts": sum(runs) / len(runs) if runs else 0,
                # Интервал, в который попали 8 из 10 прогонов.
                "proj_pts_low": percentile(runs, 0.10),
                "proj_pts_high": percentile(runs, 0.90),
                "proj_pts_median": percentile(runs, 0.50),
                "attack": team_ratings[team_id][0],
                "defence": team_ratings[team_id][1],
                "rating_error": team_ratings[team_id][2],
            }
        )

    results.sort(key=lambda r: (-r["playoff_pct"], -r["proj_pts"]))

    # Черта плей-офф и первого места: сколько очков у восьмого и первого
    # клуба конференции в обычном прогоне (медиана) и в «тяжёлом» (9 из 10
    # прогонов не выше этого числа — набрав на очко больше, почти наверняка
    # окажешься выше черты).
    lines = {}
    for key, runs in line_runs.items():
        lines[key] = {}
        for name, values in runs.items():
            ordered = sorted(values)
            lines[key][name] = {
                "median": percentile(ordered, 0.50),
                "high": percentile(ordered, 0.90),
            }

    # Шансы в каждом оставшемся матче, в процентах, с точки зрения хозяев.
    matchups = {}
    for game, counts in zip(remaining, outcome_counts):
        total = sum(counts) or 1
        matchups[str(game["id"])] = [round(100.0 * c / total, 1) for c in counts]

    return {
        "sims": sims,
        "seed": seed,
        "league_avg_goals": avg,
        "home_advantage": home_adv,
        "prior_games": PRIOR_GAMES,
        "games_remaining": len(remaining),
        "games_played": sum(1 for g in games if g.get("state") == "finished"),
        "teams": results,
        "lines": lines,
        "matchups": matchups,
    }


if __name__ == "__main__":
    import sys
    import collect

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    data = collect.load()
    out = simulate(data, sims=2000, progress=lambda i, n: print(f"  {i}/{n}"))
    print(f"\nλ лиги {out['league_avg_goals']:.2f} · дом {out['home_advantage']:.3f} "
          f"· осталось матчей {out['games_remaining']}\n")
    for row in out["teams"]:
        print(f"  {row['name']:<16} {row['conference']:<7} "
              f"плей-офф {row['playoff_pct']:5.1f}%  "
              f"1-е место {row['conf_first_pct']:4.1f}%  "
              f"прогноз очков {row['proj_pts']:5.1f}")
