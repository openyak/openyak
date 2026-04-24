"""Refresh the bundled skills catalog from skillsmp.com.

Run this before every OpenYak release (``release_prep`` step) to keep
the "Browse skills" store browsable without live network calls.

Why a bundled snapshot instead of a live proxy:

- SkillsMP's anonymous quota is 50 requests/day per IP, which burns
  out in minutes under search-as-you-type. Manual refresh avoids the
  problem entirely.
- The 1000-result cap per query means we can't enumerate all 900k+
  skills — only the top slice. A manual scrape with curated queries
  gives us deterministic coverage of what our users actually see.
- Zero runtime dependency on a third party's uptime.

Usage:

    python backend/scripts/update_skills_catalog.py

Output: ``backend/app/data/skills_catalog.json`` (overwrites in place).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx


_OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "skills_catalog.json"
_API = "https://skillsmp.com/api/v1/skills/search"

# Per-query 1000-result cap + 50/page limit → we cap at 6 pages per
# (query, sort) pair. Multiple broad queries widen the population via
# dedupe on skill id.
_PAGES_PER_AXIS = 6
_PAGE_SIZE = 50
_QUERIES = ("a", "e", "the", "skill")
_SORTS = ("stars", "recent")
_COURTESY_DELAY = 0.2


def _fetch(client: httpx.Client, q: str, sort: str, page: int) -> dict:
    r = client.get(
        _API,
        params={"q": q, "limit": _PAGE_SIZE, "sortBy": sort, "page": page},
    )
    r.raise_for_status()
    return r.json()["data"]


def main() -> int:
    skills: dict[str, dict] = {}
    with httpx.Client(timeout=15) as client:
        for q in _QUERIES:
            for sort in _SORTS:
                for page in range(1, _PAGES_PER_AXIS + 1):
                    try:
                        data = _fetch(client, q, sort, page)
                    except httpx.HTTPError as e:
                        print(f"  q={q} sort={sort} page={page} -> ERROR {e}")
                        break
                    batch = data.get("skills", [])
                    pag = data.get("pagination", {})
                    print(
                        f"  q={q:<5} sort={sort:<6} page={page} -> "
                        f"{len(batch):>2} (hasNext={pag.get('hasNext')})"
                    )
                    for s in batch:
                        existing = skills.get(s["id"])
                        if not existing or (s.get("stars") or 0) > (
                            existing.get("stars") or 0
                        ):
                            skills[s["id"]] = s
                    if not pag.get("hasNext"):
                        break
                    time.sleep(_COURTESY_DELAY)

    out = list(skills.values())
    out.sort(key=lambda s: (-(s.get("stars") or 0)))

    payload = {
        "generated_at": int(time.time()),
        "source": "skillsmp.com (scripts/update_skills_catalog.py)",
        "count": len(out),
        "skills": out,
    }
    _OUT.parent.mkdir(parents=True, exist_ok=True)
    _OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(
        f"\nWrote {_OUT}  "
        f"({_OUT.stat().st_size / 1024:.1f} KB, {len(out)} unique skills)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
