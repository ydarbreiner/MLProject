#!/usr/bin/env python3
"""
Serialize Alembic migrations across multiple containers by taking a Postgres
advisory lock before running ``alembic upgrade head``.
"""
import os
import subprocess
import sys
import time
from typing import Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import OperationalError

# Arbitrary constant that uniquely identifies our advisory lock.
ADVISORY_LOCK_ID = 861476512341
MAX_ATTEMPTS = 30
SLEEP_SECONDS = 2


def wait_for_connection(database_url: str) -> Connection:
    """Return an open SQLAlchemy connection, retrying until Postgres is ready."""
    engine = create_engine(database_url, pool_pre_ping=True)
    last_error: Optional[BaseException] = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        conn: Optional[Connection] = None
        try:
            conn = engine.connect()
            conn.execute(text("SELECT 1"))
            return conn
        except OperationalError as exc:
            last_error = exc
            if conn is not None and not conn.closed:
                conn.close()
            time.sleep(SLEEP_SECONDS)

    assert last_error is not None
    raise last_error


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL environment variable is required", file=sys.stderr)
        return 1

    connection = wait_for_connection(database_url)
    locked = False
    try:
        connection.execute(
            text("SELECT pg_advisory_lock(:lock_id)"),
            {"lock_id": ADVISORY_LOCK_ID},
        )
        locked = True
        print("Running Alembic migrations...", flush=True)
        subprocess.run(["alembic", "upgrade", "head"], check=True)
    finally:
        if locked:
            connection.execute(
                text("SELECT pg_advisory_unlock(:lock_id)"),
                {"lock_id": ADVISORY_LOCK_ID},
            )
        connection.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
