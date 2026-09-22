"""
Shared pytest fixtures for the facility-api end-to-end suite.

The suite runs against a real PostgreSQL (the schema is created automatically on
first connection), because the value of these tests is in exercising the SQL,
the role scoping and the workflow constraints together. Point the ``POSTGRES_*``
environment variables at a throwaway database - the session fixture truncates
every table before it starts.
"""

import os
import pathlib
import sys

import pytest

# Import the service package without installing it. The tests live outside
# `backend/` so they are neither shipped in the Lambda package nor scanned by
# the Bandit workflow, which runs against `./backend` and rejects bare asserts.
SERVICE_ROOT = pathlib.Path(__file__).resolve().parents[1] / "backend" / "facility-api"
sys.path.insert(0, str(SERVICE_ROOT))

# Keep hashing cheap so the suite stays fast; production uses config.py defaults.
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ.setdefault("JWT_SECRET", "test-signing-key")
os.environ.setdefault("IS_LOCAL", "true")

PASSWORD = "workshop-pass-123"  # a fixture credential for the throwaway test database


@pytest.fixture(scope="session")
def client():
    """
    Yield a ``TestClient`` bound to the prefix-wrapped ASGI app, on a clean database.

    Yields:
        fastapi.testclient.TestClient: Client for the whole test session.
    """
    from fastapi.testclient import TestClient

    from app.database import execute
    from app.main import app

    execute(
        "TRUNCATE incident_notes, incidents, seats, floors, buildings, "
        "engineer_profiles, users RESTART IDENTITY CASCADE"
    )
    with TestClient(app) as test_client:
        yield test_client


def register(client, email: str, name: str) -> dict:
    """
    Register an account and return the created user.

    Args:
        client: The test client.
        email: An ``@acme.inc`` address.
        name: The user's full name.

    Returns:
        dict: The created user record.
    """
    response = client.post(
        "/auth/register", json={"email": email, "full_name": name, "password": PASSWORD}
    )
    assert response.status_code == 201, response.text
    return response.json()


def auth_header(client, email: str) -> dict[str, str]:
    """
    Log in and return an ``Authorization`` header for the account.

    Args:
        client: The test client.
        email: The account's address.

    Returns:
        dict: A bearer ``Authorization`` header.
    """
    response = client.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture(scope="session")
def world(client) -> dict:
    """
    Build the shared fixture data: three personas and one building/floor/seat.

    Args:
        client: The session test client.

    Returns:
        dict: Users, auth headers and facility ids used across the suite.
    """
    admin = register(client, "admin@acme.inc", "Ada Admin")
    assert admin["role"] == "facility_admin", "first account must bootstrap the admin"
    employee = register(client, "dana@acme.inc", "Dana Ruiz")
    engineer_user = register(client, "sam@acme.inc", "Sam Okafor")
    other = register(client, "other@acme.inc", "Otto Other")

    admin_h = auth_header(client, "admin@acme.inc")

    building = client.post(
        "/buildings", json={"name": "HQ North", "address": "1 Market St"}, headers=admin_h
    ).json()
    floor = client.post(
        f"/buildings/{building['id']}/floors",
        json={"level": 3, "name": "Engineering"},
        headers=admin_h,
    ).json()
    seat = client.post(
        f"/floors/{floor['id']}/seats",
        json={"code": "3A-12", "description": "Window desk"},
        headers=admin_h,
    ).json()
    engineer = client.post(
        "/engineers",
        json={
            "user_id": engineer_user["id"],
            "specialties": ["AV_EQUIPMENT", "HARDWARE"],
            "max_active_incidents": 2,
        },
        headers=admin_h,
    ).json()

    return {
        "admin": admin,
        "employee": employee,
        "engineer_user": engineer_user,
        "other": other,
        "engineer": engineer,
        "building": building,
        "floor": floor,
        "seat": seat,
        "admin_h": admin_h,
        "employee_h": auth_header(client, "dana@acme.inc"),
        "engineer_h": auth_header(client, "sam@acme.inc"),
        "other_h": auth_header(client, "other@acme.inc"),
    }
