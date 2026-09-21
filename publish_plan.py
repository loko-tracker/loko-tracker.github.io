"""Что публиковать на сайт — для ежедневного обновления.

    python publish_plan.py          # печатает план публикации (JSON)
    python publish_plan.py --mark   # запомнить: всё из плана опубликовано

Страница публичной версии меняется каждый день (в ней зашифрованные
данные), а код, стили и логотипы лежат рядом отдельными файлами и меняются
редко. Перепубликовывать их каждый раз незачем, но и забыть нельзя: новая
страница со старым кодом может не заработать. Поэтому здесь хранятся
отпечатки файлов, опубликованных в прошлый раз, и в план попадают только
изменившиеся.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import site_pages

ROOT = Path(__file__).parent
SITE = ROOT / "site.json"
LEDGER = site_pages.PUBLISH / ".published.json"


def _digest(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plan() -> dict:
    site = json.loads(SITE.read_text(encoding="utf-8"))
    assets = site_pages.web_asset_map()
    published = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}

    changed = {
        name: source
        for name, source in assets.items()
        if published.get(name) != _digest(source)
    }
    # Картинки новостей и старые спрайты уходят со страницы — убираем их
    # и с сайта (null в карте файлов), иначе файлы копились бы до предела.
    for name in published:
        if name not in assets and name.startswith("photos/"):
            changed[name] = None
    return {
        "url": site["public_url"],
        "page": str(site_pages.WEB_PAGE),
        "files": changed,
    }


def mark() -> int:
    assets = site_pages.web_asset_map()
    LEDGER.write_text(
        json.dumps({name: _digest(source) for name, source in assets.items()}, indent=1),
        encoding="utf-8",
    )
    return len(assets)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--mark" in sys.argv:
        print(f"запомнено опубликованных файлов: {mark()}")
    else:
        print(json.dumps(plan(), ensure_ascii=False, indent=1))
