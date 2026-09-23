"""Портреты игроков всех клубов лиги — одной картинкой на команду.

В API лиги у каждого игрока есть ссылка на портрет на khl.ru (квадрат
320×320 на белом фоне). Поштучно их не опубликовать: у страницы на
claude.ai ограничено число файлов. Поэтому портреты каждой команды
склеиваются в одну картинку-сетку («спрайт»), а страница показывает
нужную клетку через background-position.

Исходники кэшируются в web/photos/khl и не публикуются. Спрайт команды
называется стабильно (faces-<id>.jpg), а к адресу добавляется отпечаток
содержимого (?v=...) — сменился состав, сменился и адрес, так что браузер
не покажет старые лица на новых местах.

«Локомотив» пропускаем: его игроков сайт показывает фотографиями
с сайта клуба, взятыми по ссылке.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path

try:
    from PIL import Image
except ImportError:                     # без Pillow спрайты не собрать
    Image = None

PHOTOS = Path(__file__).parent / "web" / "photos"
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    ),
}
CACHE = PHOTOS / "khl"
DATA_FILE = Path(__file__).parent / "data" / "league_faces.json"
CELL = 128
COLS = 6


def _source_name(url: str) -> str | None:
    match = re.search(r"teamplayers_db/(\d+)/(\d+)\.(jpe?g|png)", url or "")
    return f"t{match.group(1)}-p{match.group(2)}.jpg" if match else None


def _download(jobs: list[tuple[str, str]], progress) -> int:
    """Докачивает недостающие портреты в кэш (без ужатия — ужмём в спрайте)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    todo = [(url, name) for url, name in jobs if not (CACHE / name).exists()]
    if not todo:
        return 0
    from concurrent.futures import ThreadPoolExecutor
    import urllib.request

    headers = {**HEADERS, "Referer": "https://www.khl.ru/"}

    def fetch(job):
        url, name = job
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                (CACHE / name).write_bytes(response.read())
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        done = sum(pool.map(fetch, todo))
    progress(f"  портреты лиги: скачано {done} из {len(todo)} новых")
    return done


def _sprite(files: list[Path]) -> bytes:
    rows = (len(files) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * CELL, rows * CELL), (255, 255, 255))
    for index, path in enumerate(files):
        with Image.open(path) as face:
            face = face.convert("RGB").resize((CELL, CELL), Image.LANCZOS)
            sheet.paste(face, ((index % COLS) * CELL, (index // COLS) * CELL))
    out = io.BytesIO()
    sheet.save(out, "JPEG", quality=78, optimize=True, progressive=True)
    return out.getvalue()


def sync(players: list[dict], skip_teams=(26,), progress=print) -> dict:
    """{"sprites": {team: {file, v, cols, rows}}, "players": {id: [team, index]}}."""
    if Image is None:
        progress("  портреты лиги: нет Pillow — пропускаю")
        return {"sprites": {}, "players": {}}

    by_team: dict[int, list[tuple[dict, str]]] = {}
    jobs = []
    for p in players:
        team = p.get("team_id")
        name = _source_name(p.get("image"))
        if not team or team in skip_teams or not name:
            continue
        by_team.setdefault(team, []).append((p, name))
        jobs.append((p["image"], name))
    _download(jobs, progress)

    sprites, faces = {}, {}
    for team, members in sorted(by_team.items()):
        members = [(p, name) for p, name in members if (CACHE / name).exists()]
        members.sort(key=lambda item: str(item[0].get("id")))
        if not members:
            continue
        data = _sprite([CACHE / name for _, name in members])
        file = f"faces-{team}.jpg"
        target = PHOTOS / file
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
        sprites[str(team)] = {
            "file": file,
            "v": hashlib.sha1(data).hexdigest()[:10],
            "cols": COLS,
            "rows": (len(members) + COLS - 1) // COLS,
        }
        for index, (p, _) in enumerate(members):
            faces[str(p.get("id"))] = [team, index]

    progress(f"  портреты лиги: {len(faces)} игроков в {len(sprites)} картинках")
    return {"sprites": sprites, "players": faces}


def save(data: dict) -> dict:
    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def load() -> dict:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"sprites": {}, "players": {}}
