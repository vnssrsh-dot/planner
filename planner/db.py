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
    last_evening_date TEXT,                  -- дата последнего вечернего напоминания
    last_morning_date TEXT,                  -- дата последней утренней сводки
    created_date      TEXT,                  -- день знакомства с ботом
    welcome_sent      INTEGER NOT NULL DEFAULT 0, -- приглашение заполнить планер уже отправлено
    started_at        TEXT,                  -- момент первого /start (UTC ISO)
    remind_before     INTEGER                -- последний выбор «Нагадати за» (по умолчанию для новых дел)
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
    reminded   INTEGER NOT NULL DEFAULT 0,   -- «Незабаром» уже отправлено
    created_at TEXT NOT NULL,
    followed_up  INTEGER NOT NULL DEFAULT 0, -- «Час минув» отправлено (или не нужно)
    scheduled_at TEXT,                       -- когда делу последний раз задали дату/время (UTC ISO)
    remind_before INTEGER                    -- «Нагадати за», минут (NULL = 15)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);

-- Звички: kind = 'build' (робити регулярно) або 'quit' (позбутися шкідливої)
CREATE TABLE IF NOT EXISTS habits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'build',
    start_date TEXT NOT NULL,                -- YYYY-MM-DD, день створення (історично)
    created_at TEXT NOT NULL,
    base_start TEXT                          -- день створення; старт = найраніша відмітка, інакше він
);

-- Відмітки: звичку виконано / день без зриву
CREATE TABLE IF NOT EXISTS habit_marks (
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    PRIMARY KEY (habit_id, date)
);
"""

TASK_FIELDS = ("id", "date", "time", "title", "note", "done", "done_at")
REMIND_OPTIONS = (15, 20, 30, 40, 50, 60, 180, 300, 480, 720, 1440)  # «Нагадати за», минут
DEFAULT_REMIND = 15


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _task(row: aiosqlite.Row) -> dict[str, Any]:
    d = {k: row[k] for k in TASK_FIELDS}
    d["done"] = bool(d["done"])
    d["remind_before"] = row["remind_before"] if row["remind_before"] is not None else DEFAULT_REMIND
    return d


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        # база, созданная раньше — добавляем новые колонки
        for col in ("last_morning_date TEXT", "created_date TEXT", "welcome_sent INTEGER NOT NULL DEFAULT 0",
                    "started_at TEXT", "remind_before INTEGER"):
            try:
                await self.conn.execute(f"ALTER TABLE users ADD COLUMN {col}")
            except aiosqlite.OperationalError:
                pass
        for col in ("followed_up INTEGER NOT NULL DEFAULT 0", "scheduled_at TEXT", "remind_before INTEGER"):
            try:
                await self.conn.execute(f"ALTER TABLE tasks ADD COLUMN {col}")
            except aiosqlite.OperationalError:
                pass
        try:
            await self.conn.execute("ALTER TABLE habits ADD COLUMN base_start TEXT")
        except aiosqlite.OperationalError:
            pass
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
            INSERT INTO users (id, chat_id, first_name, tz, created_date) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                chat_id    = COALESCE(excluded.chat_id, users.chat_id),
                first_name = COALESCE(excluded.first_name, users.first_name),
                tz         = COALESCE(excluded.tz, users.tz)
            """,
            (user_id, chat_id, first_name, tz, _now()[:10]),
        )
        await self.conn.commit()

    async def get_user(self, user_id: int) -> aiosqlite.Row | None:
        cur = await self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return await cur.fetchone()

    async def all_users(self) -> list[aiosqlite.Row]:
        cur = await self.conn.execute("SELECT * FROM users WHERE chat_id IS NOT NULL")
        return list(await cur.fetchall())

    async def mark_started(self, user_id: int) -> None:
        await self.conn.execute(
            "UPDATE users SET started_at = ? WHERE id = ? AND started_at IS NULL", (_now(), user_id)
        )
        await self.conn.commit()

    async def mark_welcome_sent(self, user_id: int) -> None:
        await self.conn.execute("UPDATE users SET welcome_sent = 1 WHERE id = ?", (user_id,))
        await self.conn.commit()

    async def has_activity(self, user_id: int) -> bool:
        cur = await self.conn.execute(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE user_id = ?) OR EXISTS(SELECT 1 FROM habits WHERE user_id = ?)",
            (user_id, user_id),
        )
        return bool((await cur.fetchone())[0])

    async def set_last_morning(self, user_id: int, date: str) -> None:
        await self.conn.execute("UPDATE users SET last_morning_date = ? WHERE id = ?", (date, user_id))
        await self.conn.commit()

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

    async def remind_default(self, user_id: int) -> int:
        cur = await self.conn.execute("SELECT remind_before FROM users WHERE id = ?", (user_id,))
        row = await cur.fetchone()
        return row["remind_before"] if row and row["remind_before"] is not None else DEFAULT_REMIND

    async def set_remind_default(self, user_id: int, minutes: int) -> None:
        await self.conn.execute("UPDATE users SET remind_before = ? WHERE id = ?", (minutes, user_id))
        await self.conn.commit()

    async def create_task(
        self, user_id: int, *, date: str, title: str, time: str | None = None, note: str = "",
        remind_before: int | None = None,
    ) -> dict:
        if remind_before is None:
            remind_before = await self.remind_default(user_id)
        cur = await self.conn.execute(
            "INSERT INTO tasks (user_id, date, time, title, note, created_at, scheduled_at, remind_before)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, date, time, title, note, _now(), _now(), remind_before),
        )
        await self.conn.commit()
        return await self.get_task(user_id, cur.lastrowid)

    async def update_task(self, user_id: int, task_id: int, **fields: Any) -> dict | None:
        allowed = {k: v for k, v in fields.items() if k in ("date", "time", "title", "note", "done", "remind_before")}
        if "remind_before" in allowed and not ("date" in allowed or "time" in allowed):
            cur = await self.get_task(user_id, task_id)
            if cur and cur["remind_before"] != allowed["remind_before"]:
                allowed["reminded"] = 0  # новое время напоминания
        if not allowed:
            return await self.get_task(user_id, task_id)
        if "done" in allowed:
            allowed["done"] = int(bool(allowed["done"]))
            allowed["done_at"] = _now() if allowed["done"] else None
        if "date" in allowed or "time" in allowed:
            # перенесли — оба напоминания заново
            allowed.update(reminded=0, followed_up=0, scheduled_at=_now())
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

    async def timed_pending(self, user_id: int, yesterday: str, today: str) -> list[dict]:
        cur = await self.conn.execute(
            """
            SELECT id, date, time, title, note, reminded, followed_up, scheduled_at, remind_before FROM tasks
            WHERE user_id = ? AND date BETWEEN ? AND ? AND time IS NOT NULL AND done = 0
              AND (reminded = 0 OR followed_up = 0)
            """,
            (user_id, yesterday, today),
        )
        return [dict(r) for r in await cur.fetchall()]

    async def mark_followed_up(self, task_id: int) -> None:
        await self.conn.execute("UPDATE tasks SET reminded = 1, followed_up = 1 WHERE id = ?", (task_id,))
        await self.conn.commit()

    async def mark_reminded(self, task_id: int) -> None:
        await self.conn.execute("UPDATE tasks SET reminded = 1 WHERE id = ?", (task_id,))
        await self.conn.commit()

    # ---------- habits ----------

    async def habits(self, user_id: int) -> list[dict]:
        cur = await self.conn.execute(
            "SELECT id, title, kind, start_date, base_start, created_at FROM habits WHERE user_id = ? ORDER BY id",
            (user_id,),
        )
        habits = [dict(r) for r in await cur.fetchall()]
        if not habits:
            return []
        cur = await self.conn.execute(
            f"SELECT habit_id, date FROM habit_marks WHERE habit_id IN ({','.join('?' * len(habits))}) ORDER BY date",
            [h["id"] for h in habits],
        )
        marks: dict[int, list[str]] = {}
        for r in await cur.fetchall():
            marks.setdefault(r["habit_id"], []).append(r["date"])
        out = []
        for h in habits:
            # старт = найраніша відмітка; без відміток — день створення
            lst = sorted(marks.get(h["id"], []))
            base = h["base_start"] or (h["created_at"] or "")[:10] or h["start_date"]
            out.append({"id": h["id"], "title": h["title"], "kind": h["kind"],
                        "start_date": lst[0] if lst else base, "base_start": base, "marks": lst})
        return out

    async def get_habit(self, user_id: int, habit_id: int) -> dict | None:
        return next((h for h in await self.habits(user_id) if h["id"] == habit_id), None)

    async def create_habit(self, user_id: int, *, title: str, kind: str, start_date: str) -> dict:
        cur = await self.conn.execute(
            "INSERT INTO habits (user_id, title, kind, start_date, created_at, base_start) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, title, kind, start_date, _now(), start_date),
        )
        await self.conn.commit()
        return await self.get_habit(user_id, cur.lastrowid)

    async def update_habit(self, user_id: int, habit_id: int, **fields: Any) -> dict | None:
        allowed = {k: v for k, v in fields.items() if k in ("title", "kind")}
        if allowed:
            sets = ", ".join(f"{k} = ?" for k in allowed)
            await self.conn.execute(
                f"UPDATE habits SET {sets} WHERE id = ? AND user_id = ?", (*allowed.values(), habit_id, user_id)
            )
            await self.conn.commit()
        return await self.get_habit(user_id, habit_id)

    async def delete_habit(self, user_id: int, habit_id: int) -> bool:
        cur = await self.conn.execute("DELETE FROM habits WHERE id = ? AND user_id = ?", (habit_id, user_id))
        if cur.rowcount:
            await self.conn.execute("DELETE FROM habit_marks WHERE habit_id = ?", (habit_id,))
        await self.conn.commit()
        return cur.rowcount > 0

    async def set_habit_mark(self, user_id: int, habit_id: int, date: str, on: bool) -> dict | None:
        if not await self.get_habit(user_id, habit_id):
            return None
        if on:
            await self.conn.execute(
                "INSERT OR IGNORE INTO habit_marks (habit_id, date) VALUES (?, ?)", (habit_id, date)
            )
        else:
            await self.conn.execute("DELETE FROM habit_marks WHERE habit_id = ? AND date = ?", (habit_id, date))
        await self.conn.commit()
        return await self.get_habit(user_id, habit_id)

    async def unmarked_habits(self, user_id: int, date: str) -> list[dict]:
        return [h for h in await self.habits(user_id) if date not in h["marks"] and h["start_date"] <= date]
