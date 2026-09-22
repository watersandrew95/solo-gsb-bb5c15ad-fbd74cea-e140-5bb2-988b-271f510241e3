"""SQLite 持久化：实验的保存 / 列表 / 读取 / 删除。"""

import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "reverb.db"))


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS experiments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                config TEXT NOT NULL
            )
            """
        )


def create_experiment(name: str, config: dict) -> dict:
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO experiments (name, created_at, config) VALUES (?, ?, ?)",
            (name, created_at, json.dumps(config, ensure_ascii=False)),
        )
        exp_id = cur.lastrowid
    return {"id": exp_id, "name": name, "created_at": created_at, "config": config}


def list_experiments() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at FROM experiments ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_experiment(exp_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT id, name, created_at, config FROM experiments WHERE id = ?",
            (exp_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "config": json.loads(row["config"]),
    }


def delete_experiment(exp_id: int) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM experiments WHERE id = ?", (exp_id,))
        return cur.rowcount > 0
