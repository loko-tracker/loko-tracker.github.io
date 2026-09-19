"""Официальные составы клубов — там, где клуб их публикует.

Список игроков в API лиги — это по сути список тех, у кого есть статистика
в сезоне. Кто ещё не выходил на лёд, в нём отсутствует или висит без клуба:
у «Локомотива» так пропадали Каюмов, Емельянов и Магомедсултанов, хотя все
трое в заявке. Поэтому для клубов с открытыми данными состав берётся у
самого клуба, а статистика — из API лиги по совпадению имени.

Клуб отмечает отправленных в фарм-клуб. Отметку «травма» в заявке он,
похоже, не обновляет: Каюмов и Берёзкин в сентябре 2026 были травмированы,
а флаг стоял false. Поэтому травмы клуба — только дополнение к лазарету.

Отсюда же берутся фото игроков (портрет на сезон и снимок с матча) —
их скачивает и ужимает club_media.py.

Сейчас подключён «Локомотив» (api.hclokomotiv.ru — оттуда же берёт данные
официальный сайт клуба). Другие клубы добавляются в OFFICIAL по образцу.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
    "Accept": "application/json",
}
TIMEOUT = 30


def _get(url: str):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.load(response)


def _attrs(node) -> dict:
    """Strapi кладёт связи как {"data": {"attributes": {...}}}."""
    data = node.get("data") if isinstance(node, dict) else None
    return (data or {}).get("attributes") or {}


def _media_url(node, prefer: tuple[str, ...] = ()) -> str | None:
    """Адрес картинки из поля-медиа Strapi: нужный размер или оригинал."""
    media = _attrs(node)
    if not media:
        return None
    formats = media.get("formats") or {}
    for size in prefer:
        url = (formats.get(size) or {}).get("url")
        if url:
            return url
    return media.get("url")


ROLES = {
    "goaltender": "вратарь",
    "defenseman": "защитник",
    "forward": "нападающий",
}


def _role(position: str) -> str | None:
    """Позиция у клуба записана кодом: B — вратарь, D — защитник, F — нападающий.

    «B» бывает и латинской, и русской «В», поэтому принимаем обе, а заодно
    полные слова — на случай, если клуб сменит формат. Неизвестное — None:
    тогда позиция возьмётся из данных лиги.
    """
    text = (position or "").strip().lower()
    if not text:
        return None
    if text in ("b", "в", "g") or text.startswith(("вратар", "goal")):
        return "goaltender"
    if text in ("d", "з") or text.startswith(("защит", "def")):
        return "defenseman"
    if text in ("f", "н") or text.startswith(("напад", "for")):
        return "forward"
    return None


def _key(surname: str, first_name: str) -> tuple[str, str]:
    """Ключ для сверки имён: без регистра, «ё» как «е»."""
    def norm(text: str) -> str:
        return (text or "").strip().lower().replace("ё", "е")
    return norm(surname), norm(first_name)


def _api_key(full_name: str) -> tuple[str, str]:
    # API пишет «Фамилия Имя» и иногда добавляет инициал: «Кирьянов Никита В.»
    parts = (full_name or "").split()
    return _key(parts[0] if parts else "", parts[1] if len(parts) > 1 else "")


# ------------------------------------------------------------ «Локомотив»

LOKO_API = "https://api.hclokomotiv.ru/api"


def _loko_season_code(season: str) -> str:
    """«2026/2027» -> «2027MEN»: клуб называет сезон по году окончания."""
    return season.split("/")[-1].strip() + "MEN"


def fetch_lokomotiv(season: str) -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "populate[player][populate][0]": "position",
            "populate[player][populate][1]": "photo",
            "populate[player][populate][2]": "bg_photo",
            "populate[player][populate][3]": "main_bg_photo",
            "populate[assignment]": "*",
            "filters[season][name][$eq]": _loko_season_code(season),
            "filters[active][$eq]": "true",
            "pagination[page]": "1",
            "pagination[pageSize]": "100",
        },
        safe="[]$*",
    )
    payload = _get(f"{LOKO_API}/team-rosters?{query}")

    roster = []
    for item in payload.get("data") or ():
        entry = item.get("attributes") or {}
        player = _attrs(entry.get("player"))
        if not player.get("surname"):
            continue                              # запись без игрока
        position = _attrs(player.get("position"))
        roster.append(
            {
                "surname": player.get("surname"),
                "first_name": player.get("name"),
                "number": entry.get("number"),
                "role_key": _role(position.get("position") or position.get("name") or ""),
                "injured": bool(entry.get("trauma")),
                "farm_club": bool(entry.get("farm_club")),
                # Портрет — квадрат 425 px на текущий сезон; снимок с матча —
                # готовый уменьшенный вариант, оригиналы там по мегабайту.
                "photo_url": _media_url(player.get("photo")),
                "action_url": _media_url(player.get("bg_photo"), ("medium", "small"))
                              or _media_url(player.get("main_bg_photo"), ("medium", "small")),
            }
        )
    return roster


# KHL team id -> (название, функция загрузки состава)
OFFICIAL = {
    26: ("Локомотив", fetch_lokomotiv),
}

# Для боковых «крыльев» сайта: что показать о клубе, кроме игроков.
# Только проверенное: оба Кубка Гагарина клуб называет в биографиях
# игроков на своём сайте, чемпионства и арена — общеизвестны.
FACTS = {
    26: [
        {"k": "Кубок Гагарина", "v": "2025 · 2026", "tone": "gold"},
        {"k": "Чемпион России", "v": "1997 · 2002 · 2003"},
        {"k": "Домашний лёд", "v": "Арена-2000"},
    ],
}


# ------------------------------------------------------------ применение

def apply(season_data: dict, season: str = "2026/2027", progress=print) -> dict:
    """Заменяет у подключённых клубов состав на официальный.

    Статистика берётся из API лиги по совпадению имени. Игроки, которые
    по API числятся за клубом и уже играли, но в заявке клуба их нет,
    остаются — их матчи были. Числящиеся за клубом без единого матча и
    без места в заявке убираются: состав клуба знает лучше.
    """
    players = season_data.get("players") or []
    teams = {t["id"]: t for t in season_data.get("teams") or []}
    # Каждый раз заново: повторный запуск не должен копить дубли.
    season_data["club_rosters"] = {}
    season_data["club_injuries"] = []

    for team_id, (club_name, fetch) in OFFICIAL.items():
        try:
            official = fetch(season)
        except Exception as error:
            # Сайт клуба лёг — оставляем данные лиги, ничего не ломаем.
            progress(f"  состав «{club_name}» с сайта клуба не получен ({type(error).__name__}) — беру данные лиги")
            continue
        if not official:
            progress(f"  состав «{club_name}» пуст на сайте клуба — беру данные лиги")
            continue

        team = teams.get(team_id, {})
        by_key = {}
        for p in players:
            by_key.setdefault(_api_key(p.get("name")), []).append(p)

        roster_keys, merged = set(), []
        for member in official:
            key = _key(member["surname"], member["first_name"])
            roster_keys.add(key)
            candidates = by_key.get(key, [])
            # Сначала тот, кого лига уже числит за клубом, потом — без клуба.
            stats = next((p for p in candidates if p.get("team_id") == team_id), None) \
                or next((p for p in candidates if not p.get("team_id")), None)
            base = dict(stats) if stats else {
                "id": f"club-{team_id}-{member['number']}-{member['surname']}",
                "gp": 0, "g": 0, "a": 0, "pts": 0, "pim": 0,
                "plus_minus": 0, "toi_avg": 0, "top_speed": 0,
            }
            base.update(
                {
                    "name": f"{member['surname']} {member['first_name']}",
                    "team_id": team_id,
                    "team": team.get("name") or club_name,
                    "conference": team.get("conference", base.get("conference", "")),
                    "number": member["number"],
                    # Позиция клуба важнее; если её нет — из данных лиги.
                    "role_key": member["role_key"] or base.get("role_key") or "forward",
                    "injured": member["injured"],
                    "farm_club": member["farm_club"],
                    "in_roster": True,
                }
            )
            base["role"] = ROLES.get(base["role_key"], base.get("role") or "")
            merged.append(base)

        # Остальные игроки лиги; из «наших» оставляем только тех, кто играл.
        kept = []
        for p in players:
            key = _api_key(p.get("name"))
            if key in roster_keys and (p.get("team_id") in (team_id, None)):
                continue                          # уже в составе выше
            if p.get("team_id") == team_id and not p.get("gp"):
                continue                          # за клубом без матчей и вне заявки
            kept.append(p)

        players = kept + merged
        # merged идёт строго по порядку official: одна запись на игрока.
        season_data["club_rosters"][str(team_id)] = [
            {
                **{k: m[k] for k in ("name", "number", "role_key", "role", "injured", "farm_club")},
                "photo_url": member.get("photo_url"),
                "action_url": member.get("action_url"),
            }
            for m, member in zip(merged, official)
        ]
        for m in merged:
            if m["injured"]:
                season_data["club_injuries"].append(
                    {
                        "player": m["name"],
                        "team": team.get("name") or club_name,
                        "team_id": team_id,
                        "status": "травма",
                        "until": "",
                        "note": "по данным клуба",
                        "source": "club",
                    }
                )

        with_stats = sum(1 for m in merged if m.get("gp"))
        progress(f"  «{club_name}»: {len(merged)} в заявке по данным клуба, "
                 f"со статистикой лиги {with_stats}, травмированы: "
                 f"{sum(1 for m in merged if m['injured'])}")

    season_data["players"] = players
    return season_data
