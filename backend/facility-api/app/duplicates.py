"""
Near-duplicate incident detection.

The worst failure mode of a facility desk is twelve tickets for one broken air
conditioner: each gets triaged, assigned and chased separately, and the
dashboards report a crisis that does not exist. This module finds the incidents
that look like the same problem, so the UI can ask "is this already reported?"
before a thirteenth arrives.

Ranking combines three signals, because no one of them survives contact with
real reports:

* **Text.** Trigram similarity rather than full-text search alone, because
  people misspell ("projecter"), abbreviate ("AC") and re-word. Two metrics are
  taken together: ``word_similarity`` finds a short query inside a longer
  title, and ``similarity`` compares two strings of similar length. Whichever
  is higher wins, which keeps the score stable whether the reporter has typed
  four words or forty.
* **Category.** Duplicates are nearly always filed under the same category, and
  this is what separates "AC leaking on level 2" from "Emergency exit light out
  on level 2" - measured on labelled fixtures, text alone scores those two
  identically because they share "level 2".
* **Location.** Same seat beats same floor beats same building, following the
  hierarchy the rest of the app already models.

The weights and threshold below were chosen against a hand-labelled fixture of
realistic reports (see ``tests/test_duplicates.py``): true duplicates scored
0.66-0.80 and unrelated incidents 0.06-0.44, so 0.55 sits in the gap with
margin on both sides.
"""

import logging
import re
from typing import Any, Final, Optional

from app.database import fetch_all, fetch_one

logger = logging.getLogger(__name__)

# How far back to look. A fault reported two months ago and still open is worth
# surfacing; one from last year is archaeology, and scanning it costs time on
# every keystroke in the report form.
LOOKBACK_DAYS: Final[int] = 60

# Above this, the UI treats a match as "probably the same problem" and
# interrupts the reporter. Below it, nothing is shown at all: a duplicate
# warning that cries wolf is worse than none, because people learn to dismiss it
# without reading.
SCORE_THRESHOLD: Final[float] = 0.55

# Weights sum to 1.0 so the score reads as a 0-1 confidence.
_WEIGHT_TEXT: Final[float] = 0.50
_WEIGHT_CATEGORY: Final[float] = 0.30
_WEIGHT_LOCATION: Final[float] = 0.20

# Location agreement, strongest first. A seat is a desk; a floor is a room-sized
# area; a building is weak evidence on its own but still better than nothing.
_SEAT_WEIGHT: Final[float] = 1.0
_FLOOR_WEIGHT: Final[float] = 0.7
_BUILDING_WEIGHT: Final[float] = 0.4

# Enough text to characterise a report without building a tsquery out of an
# essay. Titles are short; descriptions occasionally are not.
_MAX_QUERY_CHARS: Final[int] = 400

# Only these many candidates are ever returned. The report form shows a handful;
# beyond that the list stops being a prompt and becomes a search result.
_MAX_MATCHES: Final[int] = 5

# Resolved-but-not-closed incidents stay in scope deliberately: "the same fault
# came back" is a duplicate worth knowing about, and the UI can show the status.
_CANDIDATE_STATUS_CLAUSE: Final[str] = "i.status <> 'CLOSED'"

# Filled by _trigram_available() on first use; None means "not probed yet".
_TRIGRAM: Optional[bool] = None


def _trigram_available() -> bool:
    """
    Report whether ``pg_trgm`` is installed, probing the catalog once.

    ``schema.sql`` tries to create the extension but tolerates failure, because
    a database user without ``CREATE EXTENSION`` rights would otherwise abort
    the whole schema bootstrap and take the service down over a ranking
    nicety. This probe lets the query degrade to full-text search instead.

    Returns:
        bool: True when the trigram functions can be called.
    """
    global _TRIGRAM
    if _TRIGRAM is None:
        # to_regprocedure, not to_regproc: only the former parses an argument
        # list. to_regproc is given a bare name and returns NULL for anything
        # with parentheses in it, which silently pins this to the fallback.
        row = fetch_one("SELECT to_regprocedure('word_similarity(text,text)') IS NOT NULL AS ok")
        _TRIGRAM = bool((row or {}).get("ok"))
        if not _TRIGRAM:
            logger.warning("pg_trgm unavailable; duplicate detection will not tolerate typos")
    return _TRIGRAM


def reset_capability_probe() -> None:
    """Forget the cached ``pg_trgm`` probe. Used by tests to exercise both paths."""
    global _TRIGRAM
    _TRIGRAM = None


def _search_terms(text: str) -> str:
    """
    Reduce free text to something ``websearch_to_tsquery`` can OR together.

    Every word becomes an alternative rather than a requirement. Requiring all
    of them (the default) is far too strict for this job: "Meeting room 3A
    projector dead" and "Projector will not power on in Meeting Room 3A" are
    plainly the same fault but share only three words out of six.

    ``websearch_to_tsquery`` is used rather than ``to_tsquery`` because it is
    documented never to raise on arbitrary input - and this input is whatever a
    user typed into a form.

    Args:
        text: Raw title and description text.

    Returns:
        str: A websearch-syntax query, or an empty string when there is nothing
        usable to search for.
    """
    words = re.findall(r"[\w']+", text[:_MAX_QUERY_CHARS])
    return " OR ".join(words)


def _location_score_sql(seat_id: Optional[int], floor_id: Optional[int], building_id: Optional[int]) -> tuple[str, list[Any]]:
    """
    Build the CASE expression scoring how close two incidents are physically.

    Args:
        seat_id: Optional seat of the incident being matched.
        floor_id: Optional floor.
        building_id: Optional building.

    Returns:
        tuple[str, list]: A SQL numeric expression and its bound parameters.
    """
    branches: list[str] = []
    params: list[Any] = []
    if seat_id is not None:
        branches.append(f"WHEN i.seat_id = %s THEN {_SEAT_WEIGHT}")
        params.append(seat_id)
    if floor_id is not None:
        branches.append(f"WHEN i.floor_id = %s THEN {_FLOOR_WEIGHT}")
        params.append(floor_id)
    if building_id is not None:
        branches.append(f"WHEN i.building_id = %s THEN {_BUILDING_WEIGHT}")
        params.append(building_id)
    if not branches:
        # No location given: score every candidate the same rather than
        # penalising them all, so the text and category signals decide.
        return "0.0", []
    return "CASE " + " ".join(branches) + " ELSE 0.0 END", params


def _reasons(row: dict[str, Any]) -> list[str]:
    """
    Explain a match in the words a person would use.

    A bare score is not actionable - "0.72" tells a reporter nothing about
    whether to abandon their report. The reasons are what the UI actually
    shows.

    Args:
        row: A scored candidate row.

    Returns:
        list[str]: Human-readable justifications, strongest signal first.
    """
    reasons: list[str] = []
    if row["text_score"] >= 0.45:
        reasons.append("wording is very similar")
    elif row["text_score"] > 0:
        reasons.append("wording is similar")
    if row["category_score"]:
        reasons.append("same category")
    if row["location_score"] >= _SEAT_WEIGHT:
        reasons.append("same seat")
    elif row["location_score"] >= _FLOOR_WEIGHT:
        reasons.append("same floor")
    elif row["location_score"] >= _BUILDING_WEIGHT:
        reasons.append("same building")
    return reasons


def find_similar(
    *,
    title: str,
    description: str = "",
    category: Optional[str] = None,
    building_id: Optional[int] = None,
    floor_id: Optional[int] = None,
    seat_id: Optional[int] = None,
    exclude_id: Optional[int] = None,
    visibility: tuple[str, list[Any]] = ("TRUE", []),
    threshold: float = SCORE_THRESHOLD,
    limit: int = _MAX_MATCHES,
) -> list[dict[str, Any]]:
    """
    Find open incidents that look like the same problem.

    Args:
        title: Title of the incident being reported or inspected.
        description: Optional longer text, used for recall only.
        category: Optional category; agreement is worth a large share of the score.
        building_id: Optional building of the incident being matched.
        floor_id: Optional floor.
        seat_id: Optional seat.
        exclude_id: An incident to leave out, when matching against a saved one.
        visibility: The caller's ``(clause, params)`` from the incidents router,
            used to mark which matches they may open - never to filter them out.
        threshold: Minimum score to report.
        limit: Maximum number of matches.

    Returns:
        list[dict]: Matches ordered by descending score, each carrying the
        fields the UI needs plus ``score``, ``reasons`` and ``visible``.
    """
    haystack = f"{title} {description}".strip()
    terms = _search_terms(haystack)
    if not terms:
        return []

    query_text = haystack[:_MAX_QUERY_CHARS]
    location_sql, location_params = _location_score_sql(seat_id, floor_id, building_id)
    visibility_sql, visibility_params = visibility

    if _trigram_available():
        # GREATEST of the two metrics: word_similarity locates a short query
        # inside a longer title, similarity compares like-sized strings. Taking
        # the larger keeps a four-word title and a forty-word one on one scale.
        text_sql = "GREATEST(word_similarity(%s, i.title), similarity(i.title, %s))"
        text_params: list[Any] = [query_text, query_text]
        # Recall gate: either the full-text index matches a word, or the trigram
        # metric sees enough overlap to be worth scoring.
        gate_sql = (
            "(to_tsvector('english', i.title || ' ' || i.description) @@ websearch_to_tsquery('english', %s)"
            " OR word_similarity(%s, i.title || ' ' || i.description) >= 0.25)"
        )
        gate_params: list[Any] = [terms, query_text]
    else:
        # Without pg_trgm there is no typo tolerance, so rank on the full-text
        # match alone. Normalisation 32 divides the rank by itself plus one,
        # which is what puts it on the same 0-1 scale as the trigram metrics.
        text_sql = (
            "ts_rank_cd(to_tsvector('english', i.title || ' ' || i.description),"
            " websearch_to_tsquery('english', %s), 32)"
        )
        text_params = [terms]
        gate_sql = "to_tsvector('english', i.title || ' ' || i.description) @@ websearch_to_tsquery('english', %s)"
        gate_params = [terms]

    category_sql = "CASE WHEN i.category = %s THEN 1.0 ELSE 0.0 END" if category else "0.0"
    category_params: list[Any] = [category] if category else []

    exclude_sql = "AND i.id <> %s" if exclude_id is not None else ""
    exclude_params: list[Any] = [exclude_id] if exclude_id is not None else []

    # Every identifier interpolated below is a module constant or a fragment
    # built above from constants; every value is bound with %s.
    sql = f"""
        WITH scored AS (
            SELECT i.id, i.title, i.category, i.priority, i.status, i.created_at,
                   i.building_id, b.name AS building_name,
                   i.floor_id, f.level AS floor_level,
                   i.seat_id, s.code AS seat_code,
                   ({text_sql})::float     AS text_score,
                   ({category_sql})::float AS category_score,
                   ({location_sql})::float AS location_score,
                   ({visibility_sql})      AS visible
            FROM incidents i
            LEFT JOIN buildings b ON b.id = i.building_id
            LEFT JOIN floors f ON f.id = i.floor_id
            LEFT JOIN seats s ON s.id = i.seat_id
            WHERE {_CANDIDATE_STATUS_CLAUSE}
              AND i.created_at >= NOW() - make_interval(days => %s)
              {exclude_sql}
              AND {gate_sql}
        )
        SELECT *,
               ({_WEIGHT_TEXT} * text_score
                + {_WEIGHT_CATEGORY} * category_score
                + {_WEIGHT_LOCATION} * location_score) AS score
        FROM scored
        WHERE ({_WEIGHT_TEXT} * text_score
               + {_WEIGHT_CATEGORY} * category_score
               + {_WEIGHT_LOCATION} * location_score) >= %s
        ORDER BY score DESC, created_at DESC
        LIMIT %s
    """  # nosec B608 # identifiers are module constants; every value is bound with %s

    rows = fetch_all(
        sql,
        [
            *text_params,
            *category_params,
            *location_params,
            *visibility_params,
            LOOKBACK_DAYS,
            *exclude_params,
            *gate_params,
            threshold,
            limit,
        ],
    )
    return [_serialise_match(row) for row in rows]


def _serialise_match(row: dict[str, Any]) -> dict[str, Any]:
    """
    Shape one scored row into the match object the API returns.

    Deliberately narrower than a full incident: no description, no reporter, no
    notes. Duplicate detection has to reveal that an incident exists - that is
    the entire point - but an employee who can only see their own incidents
    should not learn who filed someone else's or what they wrote in it. Title,
    status and location are enough to recognise "yes, that is my broken AC",
    and ``visible`` tells the UI whether following the link will actually work.

    Args:
        row: A scored candidate row.

    Returns:
        dict: The match representation returned to clients.
    """
    return {
        "id": row["id"],
        "title": row["title"],
        "category": row["category"],
        "priority": row["priority"],
        "status": row["status"],
        "location": {
            "building_id": row["building_id"],
            "building_name": row["building_name"],
            "floor_id": row["floor_id"],
            "floor_level": row["floor_level"],
            "seat_id": row["seat_id"],
            "seat_code": row["seat_code"],
        },
        "created_at": row["created_at"],
        "score": round(float(row["score"]), 4),
        "reasons": _reasons(row),
        "visible": bool(row["visible"]),
    }
