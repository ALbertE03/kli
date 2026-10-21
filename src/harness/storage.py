"""Persistencia SQLite de configuraciones del usuario e índice de hilos.

Las configuraciones (skills, tools HTTP, servidores MCP) pueden contener tokens,
así que se cifran con Fernet cuando SECRET_KEY está definida.
"""

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet
from pydantic import SecretStr

_SCHEMA = """
CREATE TABLE IF NOT EXISTS configs (
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kind, owner, name)
);
CREATE TABLE IF NOT EXISTS threads (
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, thread_id)
);
"""


class Storage:
    def __init__(self, path: Path, secret_key: SecretStr | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._fernet = Fernet(secret_key.get_secret_value().encode()) if secret_key else None
        with self._lock:
            self._db.executescript(_SCHEMA)
            try:  # migración de hilos existentes
                self._db.execute("ALTER TABLE threads ADD COLUMN project TEXT")
            except sqlite3.OperationalError:
                pass

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- cifrado ----
    def _encode(self, data: dict[str, Any]) -> str:
        raw = json.dumps(data, ensure_ascii=False)
        return self._fernet.encrypt(raw.encode()).decode() if self._fernet else raw

    def _decode(self, payload: str) -> dict[str, Any]:
        if self._fernet and payload.startswith("gAAAA"):
            payload = self._fernet.decrypt(payload.encode()).decode()
        result: dict[str, Any] = json.loads(payload)
        return result

    # ---- configuraciones ----
    def put_config(self, kind: str, owner: str, name: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO configs(kind, owner, name, payload) VALUES (?,?,?,?) "
                "ON CONFLICT(kind, owner, name) DO UPDATE SET payload=excluded.payload",
                (kind, owner, name, self._encode(data)),
            )
            self._db.commit()

    def get_config(self, kind: str, owner: str, name: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT payload FROM configs WHERE kind=? AND owner=? AND name=?",
                (kind, owner, name),
            ).fetchone()
        return self._decode(row["payload"]) if row else None

    def list_configs(self, kind: str, owner: str | None = None) -> list[tuple[str, str, dict[str, Any]]]:
        query = "SELECT owner, name, payload FROM configs WHERE kind=?"
        args: tuple[Any, ...] = (kind,)
        if owner is not None:
            query += " AND owner=?"
            args = (kind, owner)
        with self._lock:
            rows = self._db.execute(query + " ORDER BY created_at", args).fetchall()
        return [(r["owner"], r["name"], self._decode(r["payload"])) for r in rows]

    def delete_config(self, kind: str, owner: str, name: str) -> bool:
        with self._lock:
            cur = self._db.execute(
                "DELETE FROM configs WHERE kind=? AND owner=? AND name=?", (kind, owner, name)
            )
            self._db.commit()
            return cur.rowcount > 0

    def count_configs(self, kind: str, owner: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS n FROM configs WHERE kind=? AND owner=?", (kind, owner)
            ).fetchone()
        return int(row["n"])

    # ---- índice de hilos ----
    def touch_thread(
        self, user_id: str, thread_id: str, title: str, mode: str, project: str | None = None
    ) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO threads(user_id, thread_id, title, mode, project) VALUES (?,?,?,?,?) "
                "ON CONFLICT(user_id, thread_id) DO UPDATE SET "
                "updated_at=CURRENT_TIMESTAMP, mode=excluded.mode, project=excluded.project",
                (user_id, thread_id, title[:80], mode, project),
            )
            self._db.commit()

    def thread_exists(self, user_id: str, thread_id: str) -> bool:
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM threads WHERE user_id=? AND thread_id=?", (user_id, thread_id)
            ).fetchone()
        return row is not None

    def thread_project(self, user_id: str, thread_id: str) -> str | None:
        """Proyecto asociado al hilo (None = workspace por defecto o hilo inexistente)."""
        with self._lock:
            row = self._db.execute(
                "SELECT project FROM threads WHERE user_id=? AND thread_id=?",
                (user_id, thread_id),
            ).fetchone()
        return row["project"] if row else None

    def list_threads(self, user_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT thread_id, title, mode, project, created_at, updated_at FROM threads "
                "WHERE user_id=? ORDER BY updated_at DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_thread(self, user_id: str, thread_id: str) -> bool:
        with self._lock:
            cur = self._db.execute(
                "DELETE FROM threads WHERE user_id=? AND thread_id=?", (user_id, thread_id)
            )
            self._db.commit()
            return cur.rowcount > 0
