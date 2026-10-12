"""Напоминания (проверка раз в минуту):
 • через 30 мин после знакомства — приглашение заполнить планер (если ничего не добавлено);
 • 9:00 — план дня (тем, кто пользуется планером);
 • за 15 мин до дела со временем — «Незабаром»;
 • 21:00 — «Підсумки дня» одним сообщением.
Под каждым сообщением только кнопка «Відкрити Ritmoza» — дела меняют в приложении.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from html import escape

from aiogram import Bot

from .config import Config
from .db import Database
from .timeutil import local_now, tomorrow_of
from .views import evening_text, invite_text, morning_text, open_keyboard, reminder_keyboard

log = logging.getLogger(__name__)
INVITE_DELAY = timedelta(minutes=30)


async def check_user(bot: Bot, db: Database, cfg: Config, user) -> None:
    now = local_now(user["tz"], cfg.default_tz)
    today = now.date().isoformat()
    kb = open_keyboard(cfg.webapp_url or None)
    active = await db.has_activity(user["id"])

    # 1) Приглашение через 30 минут после первого /start — один раз и только если ничего не добавлено
    if not user["welcome_sent"] and user["started_at"]:
        if datetime.now(timezone.utc) - datetime.fromisoformat(user["started_at"]) >= INVITE_DELAY:
            await db.mark_welcome_sent(user["id"])
            if not active:
                await bot.send_message(user["chat_id"], invite_text(now.hour, user["first_name"]), reply_markup=kb)
    if not active:
        return  # дальше — только для тех, кто пользуется планером

    # 2) За N минут до дела со временем
    for t in await db.timed_unreminded(user["id"], today):
        h, m = map(int, t["time"].split(":"))
        due = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if now > due + timedelta(hours=1):
            await db.mark_reminded(t["id"])  # давно прошло — не спамим, скажем вечером
        elif now >= due - timedelta(minutes=cfg.remind_before_min):
            text = (
                f"{'Час минув' if now > due else 'Незабаром'}: <b>{escape(t['title'])}</b> о {t['time']}"
                + (f"\n<i>{escape(t['note'])}</i>" if t["note"] else "")
            )
            await bot.send_message(user["chat_id"], text, reply_markup=reminder_keyboard(t, cfg.webapp_url or None))
            await db.mark_reminded(t["id"])

    # 3) Утром — план дня, хвосты и серии привычек (в пределах 3 часов от MORNING_HOUR, раз в день)
    if cfg.morning_hour <= now.hour < cfg.morning_hour + 3 and user["last_morning_date"] != today:
        await db.set_last_morning(user["id"], today)
        tasks = await db.tasks_for_day(user["id"], today)
        overdue = await db.overdue(user["id"], today)
        habits = [h for h in await db.habits(user["id"]) if h["start_date"] <= today]
        await bot.send_message(user["chat_id"], morning_text(today, tasks, overdue, habits), reply_markup=kb)

    # 4) Вечером — «Підсумки дня» одним сообщением (если есть что сказать)
    if now.hour >= cfg.evening_hour and user["last_evening_date"] != today:
        await db.set_last_evening(user["id"], today)
        tasks = await db.tasks_for_day(user["id"], today)
        habits = await db.unmarked_habits(user["id"], today)
        tomorrow_empty = not await db.tasks_for_day(user["id"], tomorrow_of(today))
        text = evening_text(tasks, habits, tomorrow_empty)
        if text:
            await bot.send_message(user["chat_id"], text, reply_markup=kb)


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
