"""
Python script: data migration helper
Simulates a DB migration that KLI could execute during a build task.
"""

import json
import hashlib
import sqlite3
from pathlib import Path
from datetime import datetime


MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"


def hash_migrations() -> dict[str, str]:
    """Compute SHA-256 hashes for all migration files."""
    hashes: dict[str, str] = {}
    if not MIGRATIONS_DIR.exists():
        return hashes
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        content = f.read_text()
        hashes[f.stem] = hashlib.sha256(content.encode()).hexdigest()
    return hashes


def apply_migration(conn: sqlite3.Connection, version: str, sql: str) -> None:
    """Apply a single migration SQL statement."""
    conn.executescript(sql)
    conn.execute(
        "INSERT OR REPLACE INTO migrations (version, applied_at, hash) VALUES (?, ?, ?)",
        (version, datetime.utcnow().isoformat(), hashlib.sha256(sql.encode()).hexdigest()),
    )
    conn.commit()


def check_schema(conn: sqlite3.Connection) -> bool:
    """Verify the database schema matches expectations."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = {row[0] for row in cursor.fetchall()}
    expected = {"users", "auth_tokens", "migrations"}
    missing = expected - tables
    if missing:
        print(f"Missing tables: {missing}")
        return False
    print(f"Schema OK: {sorted(tables)}")
    return True


def main() -> int:
    db_path = Path(__file__).parent.parent / ".fixtures" / "integration" / "test.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS migrations (version TEXT PRIMARY KEY, applied_at TEXT, hash TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, role TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS auth_tokens (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER)")

    hashes = hash_migrations()
    ok = check_schema(conn)
    conn.close()

    return 0 if ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
