-- Schema for the ACME facility incident management platform.
-- Applied idempotently on the first database use of every Lambda cold start
-- (see app/database.py::_ensure_schema), so it must stay CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    full_name     TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL CHECK (role IN ('employee', 'engineer', 'facility_admin')),
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS buildings (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE,
    address    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS floors (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id BIGINT      NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
    level       INTEGER     NOT NULL,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (building_id, level)
);

CREATE TABLE IF NOT EXISTS seats (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id    BIGINT      NOT NULL REFERENCES floors (id) ON DELETE CASCADE,
    code        TEXT        NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (floor_id, code)
);

CREATE TABLE IF NOT EXISTS engineer_profiles (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT      NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    specialties          TEXT[]      NOT NULL DEFAULT '{}',
    phone                TEXT,
    is_available         BOOLEAN     NOT NULL DEFAULT TRUE,
    max_active_incidents INTEGER     NOT NULL DEFAULT 10 CHECK (max_active_incidents > 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL,
    category        TEXT        NOT NULL,
    priority        TEXT        NOT NULL DEFAULT 'MEDIUM'
                    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    status          TEXT        NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED')),
    reporter_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    assignee_id     BIGINT      REFERENCES engineer_profiles (id) ON DELETE SET NULL,
    building_id     BIGINT      REFERENCES buildings (id) ON DELETE SET NULL,
    floor_id        BIGINT      REFERENCES floors (id) ON DELETE SET NULL,
    seat_id         BIGINT      REFERENCES seats (id) ON DELETE SET NULL,
    is_escalated    BOOLEAN     NOT NULL DEFAULT FALSE,
    escalation_note TEXT,
    blocked_reason  TEXT,
    resolution      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    assigned_at     TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS incident_notes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id BIGINT      NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    author_id   BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    body        TEXT        NOT NULL,
    is_internal BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    incident_id BIGINT      REFERENCES incidents (id) ON DELETE CASCADE,
    event       TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    is_read     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refresh tokens, stored as digests so a database leak does not hand over
-- working credentials. Each use rotates: the old row is revoked and points at
-- its replacement, which is what makes reuse of an already-spent token
-- detectable.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    replaced_by BIGINT      REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Outbox for notification fan-out. The request that causes a change records
-- the bare event here - one cheap insert - and the expansion into a row per
-- recipient happens later, off that request.
CREATE TABLE IF NOT EXISTS notification_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event        TEXT        NOT NULL,
    incident_id  BIGINT      REFERENCES incidents (id) ON DELETE CASCADE,
    actor_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    detail       TEXT,
    attempts     INTEGER     NOT NULL DEFAULT 0,
    processed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes supporting the dashboard aggregations and the list filters.
CREATE INDEX IF NOT EXISTS idx_incidents_status      ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_priority    ON incidents (priority);
CREATE INDEX IF NOT EXISTS idx_incidents_category    ON incidents (category);
CREATE INDEX IF NOT EXISTS idx_incidents_reporter    ON incidents (reporter_id);
CREATE INDEX IF NOT EXISTS idx_incidents_assignee    ON incidents (assignee_id);
CREATE INDEX IF NOT EXISTS idx_incidents_building    ON incidents (building_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at  ON incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_incident        ON incident_notes (incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_pending
    ON notification_events (id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id, revoked_at);
