"""Клиент официального API КХЛ (тот, что обслуживает мобильное приложение).

Базовый хост khl.api.webcaster.pro отдаёт JSON без ключа, но:
  * страница фиксирована — 16 записей, листается параметром page;
  * соединение регулярно отваливается по таймауту, нужны повторы;
  * при частых запросах начинает тормозить, поэтому между вызовами пауза.

Все сетевые особенности спрятаны здесь. Остальные модули видят только
готовые списки словарей.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent import futures

BASE = "https://khl.api.webcaster.pro/api/khl_mobile"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9",
}

PAGE_SIZE = 16          # жёстко задано сервером, параметрами не меняется
BLOCK_SIZE = 6          # страниц за один параллельный блок
PAUSE = 0.35            # пауза между блоками, чтобы не душить API
TIMEOUT = 45
RETRIES = 4


class KhlApiError(RuntimeError):
    pass


def _url(endpoint: str, params: dict | None = None) -> str:
    url = f"{BASE}/{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    return url


def fetch_json(endpoint: str, params: dict | None = None, *, retries: int = RETRIES):
    """Один запрос с повторами и растущей паузой.

    API отваливается по таймауту довольно часто — это не ошибка данных,
    а нормальное поведение, поэтому повторяем молча и падаем только
    когда попытки кончились.
    """
    url = _url(endpoint, params)
    last: Exception | None = None

    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # 4xx повторять бессмысленно, 5xx — имеет смысл
            if error.code < 500:
                raise KhlApiError(f"{error.code} на {url}") from error
            last = error
        except Exception as error:      # таймауты, обрывы, битый JSON
            last = error

        if attempt < retries - 1:
            time.sleep(1.5 * (attempt + 1))

    raise KhlApiError(f"не удалось получить {url}: {last}")


def _extract(batch, key: str) -> list[dict]:
    if not isinstance(batch, list):
        raise KhlApiError(f"ожидался список, пришло {type(batch).__name__}")
    out = []
    for wrapper in batch:
        item = wrapper.get(key) if isinstance(wrapper, dict) else None
        if isinstance(item, dict) and item.get("id") is not None:
            out.append(item)
    return out


def fetch_paged(endpoint: str, params: dict | None = None, *,
                key: str, max_pages: int = 300, progress=None) -> list[dict]:
    """Листает эндпоинт до конца и возвращает уникальные записи.

    Запросы идут блоками по BLOCK_SIZE страниц одновременно. Последовательный
    обход тут не годится: сервер отвечает медленно и нестабильно, и на ~80
    страницах это давало больше двадцати минут почти полного простоя — всё
    время уходило на ожидание сети, а не на работу.

    Признак конца — блок, не принёсший ни одной новой записи: на запредельных
    номерах страниц сервер отдаёт повтор, а не пустоту, поэтому сравниваем
    по id, а не по длине ответа.
    """
    params = dict(params or {})
    collected: dict[int, dict] = {}

    page = 1
    while page <= max_pages:
        block = list(range(page, min(page + BLOCK_SIZE, max_pages + 1)))

        def one(page_number: int):
            return fetch_json(endpoint, {**params, "page": page_number})

        with futures.ThreadPoolExecutor(max_workers=len(block)) as pool:
            results = list(pool.map(one, block))

        fresh = 0
        for batch in results:
            for item in _extract(batch, key):
                if item["id"] not in collected:
                    collected[item["id"]] = item
                    fresh += 1

        if progress:
            progress(block[-1], len(collected), fresh)
        if fresh == 0:
            break

        page = block[-1] + 1
        time.sleep(PAUSE)

    return list(collected.values())


# ---------------------------------------------------------------- эндпоинты

def events(progress=None) -> list[dict]:
    """Все матчи сезона: и сыгранные (со счётом), и будущие."""
    return fetch_paged(
        "events_v2.json",
        {"order_direction": "asc"},
        key="event",
        progress=progress,
    )


def players(stage_id: int, progress=None) -> list[dict]:
    """Индивидуальная статистика всех игроков турнира."""
    return fetch_paged(
        "players_v2.json",
        {"stage_id": stage_id},
        key="player",
        progress=progress,
    )


def tables() -> dict:
    """Турнирная таблица. Отдаётся объектом целиком, без пагинации."""
    return fetch_json("tables.json")


def teams() -> list[dict]:
    """Справочник клубов: конференция, дивизион, логотип."""
    raw = fetch_json("teams_v2.json")
    return [w["team"] for w in raw if isinstance(w, dict) and "team" in w]
