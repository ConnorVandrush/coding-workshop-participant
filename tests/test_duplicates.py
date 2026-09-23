"""
Near-duplicate incident detection.

Two kinds of test live here. The endpoint tests check the contract and the
disclosure rules. The ranking tests are the ones that matter: they load a
hand-labelled fixture of realistically-worded reports and assert that every
true duplicate outranks every unrelated incident, with the threshold sitting in
the gap. Tuning weights without that fixture is guesswork.
"""

import pytest

from conftest import auth_header, register

# Each entry is (title, description, category, group). Reports sharing a group
# describe the same underlying fault, worded the way different people would
# actually word it - including a misspelling ("projecter") that full-text search
# cannot match, and an abbreviation ("AC") that shares no word with "air
# conditioning".
#
# The distractors are chosen to be hard rather than convenient: the emergency
# exit light is on the same floor as the air-conditioning leak and shares the
# phrase "level 2", and the dead switch port is in the same rack as the
# overheating rack. Text similarity alone ranks both as high as a real match.
LABELLED = [
    ("Projector will not power on in Meeting Room 3A",
     "Pressed the power button several times, no light on the unit at all.",
     "AV_EQUIPMENT", "projector"),
    ("Meeting room 3A projector dead",
     "The beamer in 3A does not switch on, tried both remotes and the wall switch.",
     "AV_EQUIPMENT", "projector"),
    ("Cannot start presentation, projecter wont turn on 3A",
     "projecter in meeting room 3a has no power, nothing happens",
     "AV_EQUIPMENT", "projector"),
    ("Air conditioning leaking over desks on level 2",
     "Water is dripping from the ceiling vent onto the desks below.",
     "HVAC", "ac-leak"),
    ("Water dripping from ceiling vent on level 2",
     "There is a puddle under the AC vent near the windows, desks are getting wet.",
     "HVAC", "ac-leak"),
    ("Data centre rack 7 running hot",
     "Rack 7 inlet temperature is well above the normal range.",
     "HVAC", "rack7"),
    ("Rack 7 temperature alarm again",
     "The data center rack 7 is overheating, alarm went off this morning.",
     "HVAC", "rack7"),
    ("Network switch port dead in rack 7",
     "Port 14 on the switch in rack 7 shows no link light.",
     "NETWORK", "switch"),
    ("Emergency exit light out on level 2 stairwell",
     "The green exit sign is dark.",
     "ELECTRICAL", "exit-light"),
    ("Kitchen tap running continuously on level 1",
     "The tap by the sink will not shut off.",
     "PLUMBING", "tap"),
    ("Desk chair gas lift collapsed at R2-15",
     "Chair sinks to the lowest position immediately.",
     "FURNITURE", "chair"),
]

# Queries a person might type into the report form, paired with the group they
# are really reporting. Short ones matter most: the form asks before the
# description is written, so the ranking has to work on a title alone.
QUERIES = [
    ("projector not working 3A", "", "AV_EQUIPMENT", "projector"),
    ("Cannot get the beamer in meeting room 3A to switch on", "", "AV_EQUIPMENT", "projector"),
    ("AC leaking level 2", "", "HVAC", "ac-leak"),
    ("rack 7 too hot", "", "HVAC", "rack7"),
    ("Water coming out of the ceiling vent on level two",
     "Desks underneath are getting soaked.", "HVAC", "ac-leak"),
]


@pytest.fixture(scope="module")
def labelled(client, world):
    """
    Report every labelled incident and return id -> group.

    Args:
        client: The session test client.
        world: Shared personas and facility fixtures.

    Returns:
        dict[int, str]: Incident id mapped to its duplicate group.
    """
    groups = {}
    for title, description, category, group in LABELLED:
        response = client.post(
            "/incidents",
            json={
                "title": title,
                "description": description,
                "category": category,
                "building_id": world["building"]["id"],
                "floor_id": world["floor"]["id"],
            },
            headers=world["employee_h"],
        )
        assert response.status_code == 201, response.text
        groups[response.json()["id"]] = group
    return groups


def _check(client, headers, title, description="", category=None, **location):
    """
    Call the duplicate-check endpoint and return its matches.

    Args:
        client: The test client.
        headers: Authorization header for the caller.
        title: Draft incident title.
        description: Optional draft description.
        category: Optional category.
        **location: Optional building_id / floor_id / seat_id.

    Returns:
        list[dict]: The ranked matches.
    """
    payload = {"title": title, "description": description, **location}
    if category:
        payload["category"] = category
    response = client.post("/incidents/duplicate-check", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["matches"]


# --------------------------------------------------------------------------
# Ranking quality
# --------------------------------------------------------------------------
@pytest.mark.parametrize("title,description,category,group", QUERIES)
def test_true_duplicates_are_found(client, world, labelled, title, description, category, group):
    """Every query surfaces at least one incident from the group it belongs to."""
    matches = _check(
        client, world["employee_h"], title, description, category,
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    found = {labelled[m["id"]] for m in matches}
    assert group in found, f"{title!r} found {found or 'nothing'}, expected {group}"


@pytest.mark.parametrize("title,description,category,group", QUERIES)
def test_unrelated_incidents_are_not_reported(client, world, labelled, title, description, category, group):
    """
    Nothing outside the query's group is returned.

    This is the half that keeps the feature usable. A duplicate prompt that
    fires on unrelated incidents trains people to dismiss it unread, at which
    point the real duplicates go through too.
    """
    matches = _check(
        client, world["employee_h"], title, description, category,
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    wrong = sorted({labelled[m["id"]] for m in matches} - {group})
    assert not wrong, f"{title!r} wrongly matched {wrong}"


def test_same_floor_wording_overlap_is_not_enough(client, world, labelled):
    """
    "level 2" in common does not make two incidents duplicates.

    The exit light and the air-conditioning leak share a floor and a phrase, and
    score identically on text alone. Only the category signal separates them, so
    this asserts the weighting still does its job.
    """
    matches = _check(
        client, world["employee_h"], "AC leaking level 2", category="HVAC",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert matches, "the real duplicates should still be found"
    assert all(labelled[m["id"]] == "ac-leak" for m in matches)


def test_typo_still_matches(client, world, labelled, monkeypatch):
    """
    A misspelling finds the correctly spelled incidents, which is the whole point of trigrams.

    The query is the single misspelled word, so nothing else can carry the
    match: only one fixture incident literally contains "projecter", and
    full-text search stems it to itself and so can never reach the other two.
    The fallback is run on the same query to prove the trigram path is what
    makes the difference - an earlier version of this test used
    "projecter broken in 3A" and passed on the fallback, because "3A" matched
    the projector incidents all on its own.
    """
    from app import duplicates

    kwargs = dict(category="AV_EQUIPMENT", building_id=world["building"]["id"],
                  floor_id=world["floor"]["id"])
    with_trigrams = _check(client, world["employee_h"], "projecter", **kwargs)
    assert {labelled[m["id"]] for m in with_trigrams} == {"projector"}
    assert len(with_trigrams) == 3, "all three wordings of the projector fault should be found"

    monkeypatch.setattr(duplicates, "_trigram_available", lambda: False)
    assert _check(client, world["employee_h"], "projecter", **kwargs) == [], (
        "without trigrams a misspelling finds nothing: full-text search stems "
        "'projecter' to itself, and the one incident that does contain the typo "
        "scores too low on a single term to clear the threshold"
    )


def test_category_disagreement_lowers_the_score(client, world, labelled):
    """
    The same text filed under the wrong category scores lower.

    Asserted as a strict inequality between two real calls rather than against a
    hard-coded number, so the test keeps its meaning if the weights are retuned.
    """
    kwargs = dict(building_id=world["building"]["id"], floor_id=world["floor"]["id"])
    right = _check(client, world["employee_h"], "projector dead in 3A", category="AV_EQUIPMENT", **kwargs)
    wrong = _check(client, world["employee_h"], "projector dead in 3A", category="PLUMBING", **kwargs)
    assert right, "the matching category should find the duplicates"
    best_right = max(m["score"] for m in right)
    best_wrong = max((m["score"] for m in wrong), default=0.0)
    assert best_right > best_wrong


def test_unrelated_text_returns_nothing(client, world, labelled):
    """An incident about something genuinely new reports no duplicates."""
    matches = _check(
        client, world["employee_h"],
        "Vending machine on the ground floor swallowed my payment",
        category="OTHER", building_id=world["building"]["id"],
    )
    assert matches == []


def test_matches_are_ordered_by_descending_score(client, world, labelled):
    """The best candidate comes first, because the UI shows the top one prominently."""
    matches = _check(
        client, world["employee_h"], "projector will not turn on 3A", category="AV_EQUIPMENT",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert len(matches) > 1
    assert matches == sorted(matches, key=lambda m: m["score"], reverse=True)


def test_location_breaks_a_tie_between_identical_text(client, world, labelled):
    """
    Identically worded faults rank by how close they are: floor beats building
    beats elsewhere.

    All three reports share a title and description, so location is the only
    thing that can separate them. An earlier version of this test compared only
    "same floor" against "different building", which still passed when the
    floor and building weights were made equal - it never exercised the step
    between them.
    """
    admin_h = world["admin_h"]
    same_building_other_floor = client.post(
        f"/buildings/{world['building']['id']}/floors",
        json={"level": 21, "name": "Ranking Test Floor"}, headers=admin_h,
    ).json()
    annex = client.post(
        "/buildings", json={"name": "Annex Duplicate Test", "address": "9 Side St"}, headers=admin_h
    ).json()
    annex_floor = client.post(
        f"/buildings/{annex['id']}/floors", json={"level": 1, "name": "Annex Ground"}, headers=admin_h
    ).json()

    text = {"title": "Ceiling tile stained and sagging",
            "description": "A tile above the walkway is bowing.", "category": "OTHER"}

    def report(building_id, floor_id):
        response = client.post(
            "/incidents", json={**text, "building_id": building_id, "floor_id": floor_id},
            headers=world["employee_h"],
        )
        assert response.status_code == 201, response.text
        return response.json()["id"]

    on_floor = report(world["building"]["id"], world["floor"]["id"])
    in_building = report(world["building"]["id"], same_building_other_floor["id"])
    elsewhere = report(annex["id"], annex_floor["id"])

    matches = _check(
        client, world["employee_h"], text["title"], text["description"], "OTHER",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    ranked = [m["id"] for m in matches]
    for incident_id in (on_floor, in_building, elsewhere):
        assert incident_id in ranked, f"incident {incident_id} should clear the threshold"
    assert ranked.index(on_floor) < ranked.index(in_building) < ranked.index(elsewhere)

    by_id = {m["id"]: m for m in matches}
    assert "same floor" in by_id[on_floor]["reasons"]
    assert "same building" in by_id[in_building]["reasons"]
    assert not any(r.startswith("same ") and r != "same category"
                   for r in by_id[elsewhere]["reasons"])


# --------------------------------------------------------------------------
# Contract
# --------------------------------------------------------------------------
def test_match_explains_itself(client, world, labelled):
    """Every match carries reasons, because a bare score is not actionable."""
    matches = _check(
        client, world["employee_h"], "projector dead 3A", category="AV_EQUIPMENT",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert matches
    top = matches[0]
    assert top["reasons"], "a match with no explanation is not usable in the UI"
    assert "same category" in top["reasons"]
    assert 0.0 <= top["score"] <= 1.0


def test_match_withholds_description_and_reporter(client, world, labelled):
    """
    The match shape discloses that an incident exists, and nothing more.

    Duplicate detection has to reveal existence - that is the feature - but an
    employee who may not read someone else's incident should not learn who filed
    it or what they wrote.
    """
    matches = _check(
        client, world["employee_h"], "projector dead 3A", category="AV_EQUIPMENT",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert matches
    assert set(matches[0]) == {
        "id", "title", "category", "priority", "status", "location",
        "created_at", "score", "reasons", "visible",
    }


def test_duplicates_from_other_reporters_are_surfaced(client, world):
    """
    An employee sees a colleague's matching incident, which they cannot otherwise read.

    Without this the feature is pointless for the exact case it exists to
    handle: twelve people reporting one broken air conditioner.
    """
    colleague = "duphunter@acme.inc"
    register(client, colleague, "Dup Hunter")
    theirs = client.post(
        "/incidents",
        json={"title": "Coffee machine leaking in the north kitchenette",
              "description": "Water pooling under the machine every morning.",
              "category": "PLUMBING", "building_id": world["building"]["id"]},
        headers=auth_header(client, colleague),
    ).json()

    # Confirm the employee genuinely cannot read it through the normal route.
    assert client.get(f"/incidents/{theirs['id']}", headers=world["employee_h"]).status_code == 404

    matches = _check(
        client, world["employee_h"], "Coffee machine leaking in north kitchenette",
        category="PLUMBING", building_id=world["building"]["id"],
    )
    match = next(m for m in matches if m["id"] == theirs["id"])
    assert match["visible"] is False, "the UI must not offer a link that 404s"


def test_visible_is_true_for_ones_the_caller_can_open(client, world, labelled):
    """An incident the caller reported themselves is marked as followable."""
    matches = _check(
        client, world["employee_h"], "projector dead 3A", category="AV_EQUIPMENT",
        building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert matches and all(m["visible"] is True for m in matches)


def test_admin_sees_everything_as_visible(client, world):
    """A facility admin may open any match, so none is marked unfollowable."""
    matches = _check(
        client, world["admin_h"], "Coffee machine leaking in north kitchenette",
        category="PLUMBING", building_id=world["building"]["id"],
    )
    assert matches and all(m["visible"] is True for m in matches)


def test_closed_incidents_are_not_duplicates(client, world):
    """
    A closed incident is history, not a duplicate.

    Resolved ones stay in scope on purpose - "the same fault came back" is worth
    knowing - so this drives the workflow all the way to CLOSED.
    """
    admin_h = world["admin_h"]
    created = client.post(
        "/incidents",
        json={"title": "Blind cord snapped in the quiet room",
              "description": "The pull cord for the window blind has come away.",
              "category": "FURNITURE", "building_id": world["building"]["id"]},
        headers=world["employee_h"],
    ).json()

    draft = dict(title="Blind cord snapped in quiet room", category="FURNITURE",
                 building_id=world["building"]["id"])
    assert any(m["id"] == created["id"] for m in _check(client, world["employee_h"], **draft))

    for target in ("RESOLVED", "CLOSED"):
        body = {"status": target}
        if target == "RESOLVED":
            body["resolution"] = "Cord replaced."
        response = client.post(f"/incidents/{created['id']}/status", json=body, headers=admin_h)
        assert response.status_code == 200, response.text

    assert not any(m["id"] == created["id"] for m in _check(client, world["employee_h"], **draft))


def test_related_excludes_the_incident_itself(client, world, labelled):
    """An incident is not its own duplicate."""
    incident_id = next(iter(labelled))
    response = client.get(f"/incidents/{incident_id}/related", headers=world["employee_h"])
    assert response.status_code == 200, response.text
    matches = response.json()["matches"]
    assert matches, "the fixture contains duplicates of this incident"
    assert all(m["id"] != incident_id for m in matches)
    assert all(labelled[m["id"]] == labelled[incident_id] for m in matches)


def test_related_marks_unreadable_matches_as_invisible(client, world):
    """
    ``/related`` applies the same disclosure rule as ``duplicate-check``.

    Self-contained rather than leaning on the incidents another test creates,
    so it cannot start passing or failing because the file was reordered.
    """
    colleague = "relatedpeer@acme.inc"
    register(client, colleague, "Related Peer")
    theirs = client.post(
        "/incidents",
        json={"title": "Hand dryer making a grinding noise in the west washroom",
              "description": "Loud grinding whenever the dryer runs.",
              "category": "HARDWARE", "building_id": world["building"]["id"]},
        headers=auth_header(client, colleague),
    ).json()
    mine = client.post(
        "/incidents",
        json={"title": "Hand dryer grinding noise west washroom",
              "description": "The dryer grinds loudly when used.",
              "category": "HARDWARE", "building_id": world["building"]["id"]},
        headers=world["employee_h"],
    ).json()

    response = client.get(f"/incidents/{mine['id']}/related", headers=world["employee_h"])
    assert response.status_code == 200, response.text
    match = next(m for m in response.json()["matches"] if m["id"] == theirs["id"])
    assert match["visible"] is False


def test_related_hides_incidents_the_caller_cannot_see(client, world, labelled):
    """The base incident still obeys visibility, so an unrelated employee gets a 404."""
    incident_id = next(iter(labelled))
    response = client.get(f"/incidents/{incident_id}/related", headers=world["other_h"])
    assert response.status_code == 404


def test_duplicate_check_requires_authentication(client):
    """The endpoint reveals incident titles, so it is never anonymous."""
    response = client.post("/incidents/duplicate-check", json={"title": "anything"})
    assert response.status_code == 401


def test_blank_title_is_rejected(client, world):
    """An empty draft has nothing to match on and fails validation rather than scanning."""
    response = client.post(
        "/incidents/duplicate-check", json={"title": "   "}, headers=world["employee_h"]
    )
    assert response.status_code == 400


def test_punctuation_only_title_matches_nothing(client, world, labelled):
    """
    Text with no searchable words returns an empty list, not an error.

    ``websearch_to_tsquery`` was chosen precisely because it tolerates whatever
    a user types; this checks the path that strips out before reaching it.
    """
    matches = _check(client, world["employee_h"], "??? !!! ---")
    assert matches == []


def test_quotes_in_the_draft_do_not_break_the_query(client, world, labelled):
    """A title containing quotes is search text, not syntax."""
    matches = _check(
        client, world["employee_h"], 'projector "will not" power on & 3A | test',
        category="AV_EQUIPMENT", building_id=world["building"]["id"],
    )
    assert all(labelled[m["id"]] == "projector" for m in matches)


def test_ranking_degrades_without_trigram_support(client, world, labelled, monkeypatch):
    """
    The full-text fallback still works when ``pg_trgm`` is missing.

    A database user without ``CREATE EXTENSION`` rights gets a service that
    finds fewer duplicates, not one that returns 500s - so the fallback branch
    is exercised rather than merely written.
    """
    from app import duplicates

    monkeypatch.setattr(duplicates, "_trigram_available", lambda: False)
    matches = _check(
        client, world["employee_h"], "Meeting room 3A projector will not power on",
        category="AV_EQUIPMENT", building_id=world["building"]["id"], floor_id=world["floor"]["id"],
    )
    assert matches, "full-text alone should still find the well-spelled duplicates"
    assert all(labelled[m["id"]] == "projector" for m in matches)
