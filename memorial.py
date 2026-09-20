"""Вкладка «Помним»: команда «Локомотива», погибшая 7 сентября 2011 года.

Хоккеисты — из заявки клуба на сезон 2011/12 (api.hclokomotiv.ru, сезон
«2012MEN»): это ровно те 26 человек, что вылетели в Минск, с номерами,
датами рождения и портретами. Тренеров, сотрудников клуба и экипажа в API
нет — они записаны здесь, по статье Википедии «Катастрофа Як-42 под
Ярославлем» и официальному списку погибших 2011 года. Где источники
расходились в должности, взята должность из официального списка.

Список не меняется, поэтому скачанное хранится в data/memorial.json и
заново не перезаписывается пустым, если сайт клуба не ответил.
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.parse
from pathlib import Path

import club_media
import club_roster

DATA_FILE = Path(__file__).parent / "data" / "memorial.json"

CRASH_DAY = dt.date(2011, 9, 7)
ROSTER_SEASON = "2012MEN"          # сезон 2011/12 по счёту клуба
EXPECTED_PLAYERS = 26
PORTRAIT = (320, 340)

CAPTAIN = ("Ткаченко", "Иван")
# Галимов выжил при падении и умер в больнице через пять дней.
DIED_LATER = {("Галимов", "Александр"): dt.date(2011, 9, 12)}

COACHES = [
    {"name": "Брэд Маккриммон", "role": "главный тренер", "age": 52, "country": "Канада"},
    {"name": "Игорь Королёв", "role": "старший тренер", "age": 41, "country": "Россия / Канада"},
    {"name": "Александр Карповцев", "role": "тренер", "age": 41, "country": "Россия"},
    {"name": "Николай Кривоносов", "role": "тренер по физподготовке", "age": 31, "country": "Беларусь / Россия"},
]

STAFF = [
    {"name": "Андрей Зимин", "role": "врач", "age": 49},
    {"name": "Владимир Пискунов", "role": "администратор", "age": 52},
    {"name": "Евгений Сидоров", "role": "методист", "age": 43},
    {"name": "Юрий Бахвалов", "role": "видеооператор", "age": 47},
    {"name": "Александр Беляев", "role": "массажист", "age": 48},
    {"name": "Евгений Куннов", "role": "массажист", "age": 31},
    {"name": "Вячеслав Кузнецов", "role": "массажист", "age": 27},
]

CREW = [
    {"name": "Андрей Соломенцев", "role": "командир воздушного судна", "age": 44},
    {"name": "Игорь Жевелов", "role": "второй пилот", "age": 49},
    {"name": "Сергей Журавлёв", "role": "бортмеханик", "age": 42},
    {"name": "Владимир Матюшкин", "role": "инженер"},
    {"name": "Надежда Максумова", "role": "бортпроводница", "age": 37},
    {"name": "Елена Сарматова", "role": "бортпроводница", "age": 29},
    {"name": "Елена Шалина", "role": "бортпроводница", "age": 27},
]

MEMORY = [
    {"when": "Арена-2000", "what": "На стене домашней арены — фотографии всех 37 погибших и надпись «Наша команда навсегда…»."},
    {"when": "3 сентября 2012", "what": "В Екатеринбурге у комплекса «Уралец» открыт памятник: хоккеист в форме «Локомотива» с номером 37."},
    {"when": "7 сентября 2012", "what": "На месте катастрофы в Туношне — гранитный крест и камень с именами погибших. Мемориалы открыты и на Леонтьевском кладбище."},
    {"when": "7 сентября 2013", "what": "В Ярославле открыт мемориал «Хоккейное братство»: 37 стальных клюшек складываются в падающую птицу и взлетающий самолёт."},
    {"when": "Навечно", "what": "Сборная Чехии закрепила номера 4, 15 и 63 за Рахунеком, Мареком и Вашичеком, Словакия — номер 38 за Паволом Демитрой."},
    {"when": "Каждое 7 сентября", "what": "«Марш тишины» по Ярославлю и минута молчания в 16:00."},
    {"when": "23 мая 2025", "what": "«Локомотив» привёз к мемориалу в Туношне Кубок Гагарина — первый в истории клуба."},
]

ROLES = {"goaltender": "вратарь", "defenseman": "защитник", "forward": "нападающий"}


def _age(birth: dt.date, day: dt.date) -> int:
    return day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))


def fetch_players() -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "populate[player][populate][0]": "position",
            "populate[player][populate][1]": "photo",
            "filters[season][name][$eq]": ROSTER_SEASON,
            "pagination[pageSize]": "100",
        },
        safe="[]$*",
    )
    payload = club_roster._get(f"{club_roster.LOKO_API}/team-rosters?{query}")

    players = []
    for item in payload.get("data") or ():
        entry = item.get("attributes") or {}
        player = club_roster._attrs(entry.get("player"))
        if not player.get("surname") or not player.get("birth"):
            continue
        position = club_roster._attrs(player.get("position"))
        key = (player["surname"], player.get("name") or "")
        birth = dt.date.fromisoformat(player["birth"])
        died = DIED_LATER.get(key, CRASH_DAY)
        role_key = club_roster._role(position.get("position") or "") or "forward"
        players.append(
            {
                "name": f"{player.get('name')} {player['surname']}",
                "surname": player["surname"],
                "number": entry.get("number"),
                "role_key": role_key,
                "role": ROLES[role_key],
                "country": (player.get("country") or "").strip(),
                "born": birth.year,
                "age": _age(birth, died),
                "died": died.isoformat(),
                "captain": key == CAPTAIN,
                "photo_url": club_roster._media_url(player.get("photo")),
            }
        )
    return players


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"players": []}


def sync(progress=print) -> dict:
    """Забирает состав 2011 года и портреты. При сбое оставляет прежнее."""
    try:
        players = fetch_players()
    except Exception as error:
        progress(f"  «Помним»: сайт клуба не ответил ({type(error).__name__}) — беру сохранённое")
        return load()
    if len(players) < EXPECTED_PLAYERS:
        progress(f"  «Помним»: на сайте клуба {len(players)} из {EXPECTED_PLAYERS} — беру сохранённое")
        return load()

    names, _ = club_media.fetch_many(
        [(p["photo_url"], "mem", PORTRAIT) for p in players if p["photo_url"]]
    )
    for p in players:
        photo = names.get(p.pop("photo_url") or "")
        if photo:
            p["photo"] = photo

    data = {"players": players}
    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    progress(f"  «Помним»: {len(players)} хоккеистов, портретов {sum(1 for p in players if p.get('photo'))}")
    return data


def payload() -> dict:
    """Всё для вкладки: хоккеисты из сохранённого, остальное — отсюда."""
    return {
        "crash_day": CRASH_DAY.isoformat(),
        "players": load().get("players", []),
        "coaches": COACHES,
        "staff": STAFF,
        "crew": CREW,
        "memory": MEMORY,
    }


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sync()
