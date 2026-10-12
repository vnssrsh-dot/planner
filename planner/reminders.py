"""Фоновые напоминания: перед задачей со временем и вечером о невыполненном."""
import asyncio
import logging
from datetime import timedelta
from html import escape

from aiogram import Bot

from .config import Config
from .db import Database
from .timeutil import local_now
from .views import day_text, tasks_keyboard

log = logging.getLogger(__name__)


async def check_user(bot: Bot, db: Database, cfg: Config, user) -> None:
    now = local_now(user["tz"], cfg.default_tz)
    today = now.date().isoformat()

    # 1) Напоминание за N минут до задачи со временем
    for t in await db.timed_unreminded(user["id"], today):
        h, m = map(int, t["time"].split(":"))
        due = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if now > due + timedelta(hours=1):
            await db.mark_reminded(t["id"])  # давно прошло — не спамим, скажем вечером
        elif now >= due - timedelta(minutes=cfg.remind_before_min):
            late = now > due
            text = (
                f"{'Час минув' if late else 'Незабаром'}: <b>{escape(t['title'])}</b> о {t['time']}"
                + (f"\n<i>{escape(t['note'])}</i>" if t["note"] else "")
            )
            await bot.send_message(user["chat_id"], text, reply_markup=tasks_keyboard([t], None, with_tomorrow=True))
            await db.mark_reminded(t["id"])

    # 2) Вечернее напоминание: день заканчивается, а задачи «горят»
    if now.hour >= cfg.evening_hour and user["last_evening_date"] != today:
        await db.set_last_evening(user["id"], today)
        tasks = await db.tasks_for_day(user["id"], today)
        open_tasks = [t for t in tasks if not t["done"]]
        if open_tasks:
            text = (
                f"<b>День добігає кінця, а {len(open_tasks)} "
                f"{_plural(len(open_tasks), 'завдання', 'завдання', 'завдань')} ще не виконано.</b>\n"
                "Позначте зроблене або перенесіть на завтра.\n\n"
                + day_text(today, tasks)
            )
            await bot.send_message(
                user["chat_id"], text,
                reply_markup=tasks_keyboard(tasks, cfg.webapp_url or None, with_tomorrow=True),
            )


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


async def reminder_loop(bot: Bot, db: Database, cfg: Config, interval: int = 60) -> None:
    while True:
        try:
            for user in await db.all_users():
                try:
                    await check_user(bot, db, cfg, user)
                except Exception:
                    log.exception("Ошибка напоминания для пользователя %s", user["id"])
        except Exception:
            log.exception("Ошибка цикла напоминаний")
        await asyncio.sleep(interval)
