"""
PostgreSQL access layer.

The module keeps a single connection at module scope so that warm Lambda
invocations reuse it (the same pattern as `backend/_examples/python-service`),
and applies the DDL in ``schema.sql`` once per cold start.
"""

import logging
import pathlib
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional, Sequence

import psycopg
from psycopg.rows import dict_row

from app.config import POSTGRES_DSN

logger = logging.getLogger(__name__)

_SCHEMA_PATH = pathlib.Path(__file__).with_name("schema.sql")

# Arbitrary but fixed key identifying the schema-bootstrap advisory lock.
_SCHEMA_LOCK_KEY = 5_170_922

# Reused across invocations inside the same Lambda execution environment.
_CONNECTION: Optional[psycopg.Connection] = None
_SCHEMA_READY = False
_LOCK = threading.Lock()


class DatabaseUnavailable(RuntimeError):
    """Raised when the database cannot be reached; surfaced to clients as 503."""


def _ensure_schema(connection: psycopg.Connection) -> None:
    """
    Apply `schema.sql` once per process.

    A burst of traffic can cold-start several Lambda containers at once, and
    concurrent ``CREATE TABLE IF NOT EXISTS`` statements race inside PostgreSQL's
    catalog. A session-level advisory lock serialises the bootstrap so only one
    container runs the DDL at a time; the rest find the objects already there.

    Args:
        connection: An open autocommit connection.
    """
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return

    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", (_SCHEMA_LOCK_KEY,))
        try:
            cur.execute(_SCHEMA_PATH.read_text(encoding="utf-8"))
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", (_SCHEMA_LOCK_KEY,))
    _SCHEMA_READY = True
    logger.info("Database schema verified")


def _connect() -> psycopg.Connection:
    """
    Open a new autocommit connection and make sure the schema exists.

    Returns:
        psycopg.Connection: A ready-to-use connection with dict rows.

    Raises:
        DatabaseUnavailable: When the database refuses or times out.
    """
    try:
        connection = psycopg.connect(POSTGRES_DSN, autocommit=True, row_factory=dict_row)
    except psycopg.Error as exc:
        logger.error("PostgreSQL connection failed: %s", exc)
        raise DatabaseUnavailable(str(exc)) from exc

    _ensure_schema(connection)
    return connection


def get_connection() -> psycopg.Connection:
    """
    Return the pooled connection, reconnecting if it was closed or broken.

    Returns:
        psycopg.Connection: A live connection.
    """
    global _CONNECTION
    with _LOCK:
        if _CONNECTION is None or _CONNECTION.closed:
            _CONNECTION = _connect()
        return _CONNECTION


def reset_connection() -> None:
    """Drop the pooled connection so the next call reconnects."""
    global _CONNECTION
    with _LOCK:
        if _CONNECTION is not None and not _CONNECTION.closed:
            _CONNECTION.close()
        _CONNECTION = None


@contextmanager
def cursor(transactional: bool = False) -> Iterator[psycopg.Cursor]:
    """
    Yield a dict-row cursor, optionally wrapped in a transaction.

    Args:
        transactional: When True, all statements issued on the cursor commit or
            roll back together. Use it for multi-statement writes such as
            "create incident + first note".

    Yields:
        psycopg.Cursor: Cursor returning ``dict`` rows.

    Raises:
        DatabaseUnavailable: When the connection drops mid-statement.
    """
    connection = get_connection()
    try:
        if transactional:
            with connection.transaction(), connection.cursor() as cur:
                yield cur
        else:
            with connection.cursor() as cur:
                yield cur
    except (psycopg.OperationalError, psycopg.InterfaceError) as exc:
        # The socket is unusable - force a reconnect on the next invocation.
        logger.error("PostgreSQL connection lost: %s", exc)
        reset_connection()
        raise DatabaseUnavailable(str(exc)) from exc


def fetch_all(sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
    """
    Run a query and return every row.

    Args:
        sql: Parameterised SQL statement.
        params: Positional query parameters.

    Returns:
        list[dict]: The result rows.
    """
    with cursor() as cur:
        cur.execute(sql, params or ())
        return list(cur.fetchall())


def fetch_one(sql: str, params: Sequence[Any] | None = None) -> Optional[dict[str, Any]]:
    """
    Run a query and return the first row, if any.

    Args:
        sql: Parameterised SQL statement.
        params: Positional query parameters.

    Returns:
        dict | None: The first row, or None when the query matched nothing.
    """
    with cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchone()


def execute(sql: str, params: Sequence[Any] | None = None) -> int:
    """
    Run a write statement and return the number of affected rows.

    Args:
        sql: Parameterised SQL statement.
        params: Positional query parameters.

    Returns:
        int: Rows affected by the statement.
    """
    with cursor() as cur:
        cur.execute(sql, params or ())
        return cur.rowcount


def ping() -> str:
    """
    Return the server version, used by the health endpoint.

    Returns:
        str: The PostgreSQL version banner.
    """
    row = fetch_one("SELECT version() AS version")
    return row["version"] if row else "unknown"
