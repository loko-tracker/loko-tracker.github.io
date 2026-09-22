"""Время сайта — всегда московское.

КХЛ объявляет время матчей по Москве, и страница показывает его как есть.
Пока обновление запускалось только на домашнем компьютере, хватало
системных часов: они и так московские. В облаке часы стоят по Гринвичу,
поэтому зона задана здесь явно — дома результат тот же, а в облаке время
матчей перестаёт уезжать на три часа назад.
"""

from __future__ import annotations

import datetime as dt

MSK = dt.timezone(dt.timedelta(hours=3))


def now() -> dt.datetime:
    """Сейчас по Москве, без пометки о зоне — как раньше писали часы."""
    return dt.datetime.now(MSK).replace(tzinfo=None)


def stamp() -> str:
    return now().isoformat(timespec="seconds")


def from_unix(seconds: float) -> dt.datetime:
    """Отметка времени из API — в московское."""
    return dt.datetime.fromtimestamp(seconds, MSK).replace(tzinfo=None)
