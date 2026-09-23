"""Новости «Локомотива» с официального сайта клуба.

Клуб отдаёт свои статьи через тот же api.hclokomotiv.ru, что и составы
с протоколами. Берём свежие материалы основной команды (метка «LOK»),
без анонсов матчевой программки — это реклама печатного издания.

Картинки и полный текст остаются у клуба: у себя храним заголовок,
подводку, начало текста и ссылку на статью. Собранное лежит
в data/club_news.json: если сайт клуба не ответит, покажем прошлую
подборку.
"""

from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

import club_roster

DATA_FILE = Path(__file__).parent / "data" / "club_news.json"

TEAM_CODE = "LOK"
LIMIT = 24
SKIP = ("анонс программки",)


def fetch(limit: int = LIMIT) -> list[dict]:
    query = urllib.parse.urlencode(
        {
            "sort": "date:desc",
            "filters[team_filter][code][$eq]": TEAM_CODE,
            "populate[preview_image]": "*",
            "populate[image]": "*",
            "populate[article_category]": "*",
            "pagination[pageSize]": str(limit + 10),
        },
        safe="[]$*:",
    )
    payload = club_roster._get(f"{club_roster.LOKO_API}/articles?{query}")

    news = []
    for item in payload.get("data") or ():
        entry = item.get("attributes") or {}
        title = (entry.get("title") or "").strip()
        if not title or title.lower().startswith(SKIP):
            continue
        news.append(
            {
                "id": item.get("id"),
                "date": entry.get("date"),
                "title": title,
                "lead": (entry.get("annotation") or "").strip(),
                "text": club_roster.excerpt(club_roster.paragraphs(entry.get("full_text"))),
                "url": club_roster.article_url(item.get("id")),
                "image_url": club_roster._media_url(entry.get("preview_image"), ("small", "medium"))
                             or club_roster._media_url(entry.get("image"), ("small", "medium")),
            }
        )
        if len(news) >= limit:
            break
    return news


def sync(progress=print) -> list[dict]:
    try:
        news = fetch()
    except Exception as error:
        progress(f"  новости клуба: сайт клуба не ответил ({type(error).__name__}) — беру сохранённые")
        return load()
    if not news:
        return load()

    for item in news:
        image = item.pop("image_url", None)
        if image:
            item["image"] = image          # картинка остаётся на сервере клуба

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(news, ensure_ascii=False, indent=1), encoding="utf-8")
    progress(f"  новости клуба: {len(news)}, с картинкой {sum(1 for n in news if n.get('image'))}")
    return news


def load() -> list[dict]:
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for item in sync():
        print(item["date"][:10], item["title"])
