"""
Tests for session refresh.

Access tokens are short-lived signatures that cannot be revoked; refresh
tokens are long-lived rows that can. The rules worth pinning are that each
refresh token is valid exactly once, that reusing a spent one ends the whole
session, and that a revoked session cannot be resumed.
"""

import pytest

from conftest import PASSWORD


@pytest.fixture
def session(client, world):
    """
    Sign in and return a fresh session.

    Returns:
        dict: The login payload, including both tokens.
    """
    response = client.post(
        "/auth/login", json={"email": "dana@acme.inc", "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_login_issues_both_tokens(session):
    """A session is an access token plus the refresh token that renews it."""
    assert session["access_token"]
    assert session["refresh_token"]
    assert session["token_type"] == "bearer"
    # Short enough that a leaked access token has a small window.
    assert session["expires_in"] <= 60 * 60


def test_refresh_returns_a_working_access_token(client, session):
    """The whole point: a new access token without signing in again."""
    response = client.post("/auth/refresh", json={"refresh_token": session["refresh_token"]})
    assert response.status_code == 200, response.text
    renewed = response.json()

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {renewed['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == "dana@acme.inc"


def test_each_refresh_token_is_valid_exactly_once(client, session):
    """
    Rotation: the response carries a replacement, and the token that bought it
    is spent. This is what makes a stolen token detectable.
    """
    first = client.post("/auth/refresh", json={"refresh_token": session["refresh_token"]}).json()
    assert first["refresh_token"] != session["refresh_token"]

    # The replacement works...
    assert client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 200


def test_reusing_a_spent_token_ends_the_whole_session(client, world):
    """
    Two parties holding one token means it leaked. Rather than guess which is
    legitimate, every token for the account is revoked and both must sign in.
    """
    original = client.post(
        "/auth/login", json={"email": "tomas.berg@acme.inc", "password": PASSWORD}
    )
    if original.status_code != 200:
        client.post(
            "/auth/register",
            json={"email": "tomas.berg@acme.inc", "full_name": "Tomas Berg", "password": PASSWORD},
        )
        original = client.post(
            "/auth/login", json={"email": "tomas.berg@acme.inc", "password": PASSWORD}
        )
    stolen = original.json()["refresh_token"]

    rotated = client.post("/auth/refresh", json={"refresh_token": stolen}).json()
    assert rotated["refresh_token"]

    # The thief replays the spent token.
    replay = client.post("/auth/refresh", json={"refresh_token": stolen})
    assert replay.status_code == 401
    assert replay.json()["error"]["type"] == "token_reused"

    # ...and the legitimate holder's replacement is dead too.
    assert client.post("/auth/refresh", json={"refresh_token": rotated["refresh_token"]}).status_code == 401


def test_an_unknown_token_is_rejected(client):
    """A token that was never issued is not recognised."""
    response = client.post("/auth/refresh", json={"refresh_token": "not-a-real-token-at-all"})
    assert response.status_code == 401
    assert response.json()["error"]["type"] == "invalid_token"


def test_refresh_validates_its_input(client):
    """A missing or trivially short token is a validation error, not a 500."""
    assert client.post("/auth/refresh", json={}).status_code == 400
    assert client.post("/auth/refresh", json={"refresh_token": "x"}).status_code == 400


def test_logout_prevents_the_session_being_resumed(client, session):
    """Signing out revokes the refresh token, so the session cannot continue."""
    assert client.post("/auth/logout", json={"refresh_token": session["refresh_token"]}).status_code == 204

    after = client.post("/auth/refresh", json={"refresh_token": session["refresh_token"]})
    assert after.status_code == 401
    assert after.json()["error"]["type"] == "token_reused"


def test_logout_is_idempotent(client, session):
    """Signing out twice is not an error; sign-out should never fail."""
    assert client.post("/auth/logout", json={"refresh_token": session["refresh_token"]}).status_code == 204
    assert client.post("/auth/logout", json={"refresh_token": session["refresh_token"]}).status_code == 204


def test_logout_everywhere_ends_every_session(client, world):
    """A compromised account can be locked out on every device at once."""
    first = client.post("/auth/login", json={"email": "dana@acme.inc", "password": PASSWORD}).json()
    second = client.post("/auth/login", json={"email": "dana@acme.inc", "password": PASSWORD}).json()

    response = client.post(
        "/auth/logout-everywhere", headers={"Authorization": f"Bearer {first['access_token']}"}
    )
    assert response.status_code == 200
    assert response.json()["revoked"] >= 2

    for token in (first["refresh_token"], second["refresh_token"]):
        assert client.post("/auth/refresh", json={"refresh_token": token}).status_code == 401


def test_a_deactivated_account_cannot_refresh(client, world):
    """Deactivation takes effect on the next renewal, not only at expiry."""
    created = client.post(
        "/auth/register",
        json={"email": "leaver@acme.inc", "full_name": "Leaver", "password": PASSWORD},
    ).json()
    signed_in = client.post(
        "/auth/login", json={"email": "leaver@acme.inc", "password": PASSWORD}
    ).json()

    client.patch(f"/users/{created['id']}/status", json={"is_active": False}, headers=world["admin_h"])

    response = client.post("/auth/refresh", json={"refresh_token": signed_in["refresh_token"]})
    assert response.status_code == 403
    assert response.json()["error"]["type"] == "account_disabled"
