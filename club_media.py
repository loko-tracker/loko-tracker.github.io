"""Фото игроков для боковых «крыльев» сайта и состава клуба.

Адреса картинок приносит club_roster.py с сайта клуба. Здесь они
скачиваются в web/photos и ужимаются: портрет — до 320×320, снимок
с матча — до 640 px в ширину. Так три десятка игроков весят около
двух мегабайт, а не десяток.

Уже скачанное повторно не качается: в имени файла на сервере клуба есть
отпечаток содержимого, и новое фото получает новое имя само.

Без Pillow файлы сохраняются как есть — тяжелее, но всё работает.
"""

from __future__ import annotations

import io
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:                     # без Pillow — оригиналы
    Image = ImageOps = None

PHOTOS = Path(__file__).parent / "web" / "photos"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
}
TIMEOUT = 30

# поле со ссылкой -> (поле с именем файла, приставка, размер)
KINDS = {
    "photo_url":  ("photo",  "head",   (320, 320)),
    "action_url": ("action", "action", (640, 640)),
}


def local_name(url: str, prefix: str) -> str:
    """Безопасное имя файла: только латиница, цифры, «._-»."""
    base = url.rsplit("/", 1)[-1].split("?", 1)[0]
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", base.rsplit(".", 1)[0]).strip("_")[:60]
    return f"{prefix}-{stem or 'photo'}.jpg"


def _shrink(data: bytes, prefix: str, box: tuple[int, int]) -> bytes:
    if Image is None:
        return data
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        if prefix == "head":
            image = ImageOps.fit(image, box, Image.LANCZOS)
        else:
            image.thumbnail(box, Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, "JPEG", quality=80, optimize=True, progressive=True)
        return out.getvalue()


def _fetch(job: tuple[str, str, str, tuple[int, int]]) -> bool:
    url, name, prefix, box = job
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        data = response.read()
    (PHOTOS / name).write_bytes(_shrink(data, prefix, box))
    return True


def sync(season_data: dict, progress=print) -> dict:
    """Докачивает недостающие фото и проставляет в составах имена файлов.

    Неудачная загрузка ничего не ломает: у игрока просто не будет фото.
    """
    rosters = season_data.get("club_rosters") or {}
    if not rosters:
        return season_data
    PHOTOS.mkdir(parents=True, exist_ok=True)

    jobs, wanted = {}, []
    for roster in rosters.values():
        for member in roster:
            for url_field, (name_field, prefix, box) in KINDS.items():
                url = member.get(url_field)
                member.pop(name_field, None)
                if not url:
                    continue
                name = local_name(url, prefix)
                wanted.append((member, name_field, name))
                if not (PHOTOS / name).exists():
                    jobs[name] = (url, name, prefix, box)

    failed = set()
    if jobs:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = pool.map(_safe_fetch, jobs.values())
            for name, ok in zip(jobs, results):
                if not ok:
                    failed.add(name)

    for member, name_field, name in wanted:
        if name not in failed and (PHOTOS / name).exists():
            member[name_field] = name

    have = sum(1 for _, _, name in wanted if name not in failed)
    note = f", не скачалось: {len(failed)}" if failed else ""
    shrink = "" if Image else " (без Pillow — оригиналы, крупнее)"
    progress(f"  фото игроков: {have} из {len(wanted)}, новых {len(jobs) - len(failed)}{note}{shrink}")
    return season_data


def _safe_fetch(job) -> bool:
    try:
        return _fetch(job)
    except Exception:
        return False


if __name__ == "__main__":
    import sys
    import collect

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    season = collect.load()
    sync(season)
    collect.save(season)
