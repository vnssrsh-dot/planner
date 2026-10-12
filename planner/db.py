"""SQLite-хранилище пользователей и задач."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY,   -- telegram user id
    chat_id           INTEGER,               -- куда слать напоминания
    first_name        TEXT,
    tz                TEXT,                  -- IANA, напр. Europe/Moscow
    last_evening_date TEXT                   -- дата последнего вечернего напоминания
);

CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    date       TEXT NOT NULL,                -- YYYY-MM-DD
    time       TEXT,                         -- HH:MM или NULL
    title      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    done_at    TEXT,
    reminded   INTEGER NOT NULL DEFAULT 0,   -- напоминание по времени уже отправлено
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);
"""

TASK_FIELDS = ("id", "date", "time", "title", "note", "done", "done_at")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _task(row: aiosqlite.Row) -> dict[str, Any]:
    d = {k: row[k] for k in TASK_FIELDS}
    d["done"] = bool(d["done"])
    return d


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    # ---------- users ----------

    async def upsert_user(
        self, user_id: int, *, chat_id: int | None = None,
        first_name: str | None = None, tz: str | None = None,
    ) -> None:
        await self.conn.execute(
            """
            INSERT INTO users (id, chat_id, first_name, tz) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                chat_id    = COALESCE(excluded.chat_id, users.chat_id),
                first_name = COALESCE(excluded.first_name, users.first_name),
                tz         = COALESCE(excluded.tz, users.tz)
            """,
            (user_id, chat_id, first_name, tz),
        )
        await self.conn.commit()

    async def get_user(self, user_id: int) -> aiosqlite.Row | None:
        cur = await self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return await cur.fetchone()

    async def all_users(self) -> list[aiosqlite.Row]:
        cur = await self.conn.execute("SELECT * FROM users WHERE chat_id IS NOT NULL")
        return list(await cur.fetchall())

    async def set_last_evening(self, user_id: int, date: str) -> None:
        await self.conn.execute(
            "UPDATE users SET last_evening_date = ? WHERE id = ?", (date, user_id)
        )
        await self.conn.commit()

    # ---------- tasks ----------

    async def tasks_between(self, user_id: int, date_from: str, date_to: str) -> list[dict]:
        cur = await self.conn.execute(
            """
            SELECT * FROM tasks WHERE user_id = ? AND date BETWEEN ? AND ?
            ORDER BY date, time IS NULL, time, id
            """,
            (user_id, date_from, date_to),
        )
        return [_task(r) for r in await cur.fetchall()]

    async def tasks_for_day(self, user_id: int, date: str, *, only_open: bool = False) -> list[dict]:
        tasks = await self.tasks_between(user_id, date, date)
        return [t for t in tasks if not t["done"]] if only_open else tasks

    async def overdue(self, user_id: int, today: str) -> list[dict]:
        cur = await self.conn.execute(
            """
            SELECT * FROM tasks WHERE user_id = ? AND date < ? AND done = 0
            ORDER BY date, time IS NULL, time, id
            """,
            (user_id, today),
        )
        return [_task(r) for r in await cur.fetchall()]

    async def get_task(self, user_id: int, task_id: int) -> dict | None:
        cur = await self.conn.execute(
            "SELECT * FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)
        )
        row = await cur.fetchone()
        return _task(row) if row else None

    async def create_task(
        self, user_id: int, *, date: str, title: str, time: str | None = None, note: str = "",
    ) -> dict:
        cur = await self.conn.execute(
            "INSERT INTO tasks (user_id, date, time, title, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, date, time, title, note, _now()),
        )
        await self.conn.commit()
        return await self.get_task(user_id, cur.lastrowid)

    async def update_task(self, user_id: int, task_id: int, **fields: Any) -> dict | None:
        allowed = {k: v for k, v in fields.items() if k in ("date", "time", "title", "note", "done")}
        if not allowed:
            return await self.get_task(user_id, task_id)
        if "done" in allowed:
            allowed["done"] = int(bool(allowed["done"]))
            allowed["done_at"] = _now() if allowed["done"] else None
        if "date" in allowed or "time" in allowed:
            allowed["reminded"] = 0  # перенесли — напомним заново
        sets = ", ".join(f"{k} = ?" for k in allowed)
        await self.conn.execute(
            f"UPDATE tasks SET {sets} WHERE id = ? AND user_id = ?",
            (*allowed.values(), task_id, user_id),
        )
        await self.conn.commit()
        return await self.get_task(user_id, task_id)

    async def delete_task(self, user_id: int, task_id: int) -> bool:
        cur = await self.conn.execute(
            "DELETE FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    async def timed_unreminded(self, user_id: int, date: str) -> list[dict]:
        cur = await self.conn.execute(
            """
            SELECT * FROM tasks
            WHERE user_id = ? AND date = ? AND time IS NOT NULL AND done = 0 AND reminded = 0
            """,
            (user_id, date),
        )
        return [_task(r) for r in await cur.fetchall()]

    async def mark_reminded(self, task_id: int) -> None:
        await self.conn.execute("UPDATE tasks SET reminded = 1 WHERE id = ?", (task_id,))
        await self.conn.commit()
