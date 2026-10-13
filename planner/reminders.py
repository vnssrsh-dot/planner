"""Напоминания (проверка раз в минуту):
 • через 30 мин после знакомства — приглашение заполнить планер (если ничего не добавлено);
 • 9:00 — план дня (тем, кто пользуется планером);
 • за 15 мин до дела со временем — «Незабаром», через 30 мин после, если не отмечено, — «Час минув»;
 • 21:00 — «Підсумки дня» одним сообщением.
Под каждым сообщением только кнопка «Відкрити Ritmoza» — дела меняют в приложении.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from html import escape

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError

from .config import Config
from .db import Database
from .timeutil import local_now, tomorrow_of
from .views import evening_text, invite_text, morning_text, open_keyboard, reminder_keyboard

log = logging.getLogger(__name__)
INVITE_DELAY = timedelta(minutes=30)
FOLLOW_UP_MIN = 30  # «Час минув» — через столько минут после времени дела


async def _deliver(bot: Bot, chat_id: int, text: str, kb) -> bool:
    """True — доставлено (или бота заблокировали); False — сбой, повторим через минуту."""
    try:
        await bot.send_message(chat_id, text, reply_markup=kb)
    except TelegramForbiddenError:
        pass
    except Exception:
        log.exception("Не удалось отправить сообщение в чат %s, повторим через минуту", chat_id)
        return False
    return True


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

    # 2) Дела со временем: за 15 мин — «Незабаром»; через 30 мин после, если не отмечено, — «Час минув».
    #    Дело, записанное уже после своего времени, не напоминаем. Дело в 23:50 получит «Час минув» после полуночи.
    yesterday = (now.date() - timedelta(days=1)).isoformat()
    tomorrow = (now.date() + timedelta(days=1)).isoformat()
    for t in await db.timed_pending(user["id"], yesterday, tomorrow):
        remind = t["remind_before"] if t["remind_before"] is not None else cfg.remind_before_min
        h, m = map(int, t["time"].split(":"))
        due = datetime.fromisoformat(t["date"]).replace(hour=h, minute=m, tzinfo=now.tzinfo)
        since = (now - due).total_seconds() / 60
        if t["scheduled_at"] and datetime.fromisoformat(t["scheduled_at"]) >= due:
            await db.mark_followed_up(t["id"]); continue
        if since > 180:
            await db.mark_followed_up(t["id"]); continue  # давно — скажет вечерняя сводка
        if not t["followed_up"] and since >= FOLLOW_UP_MIN:
            kind = "late"
        elif not t["reminded"] and -remind <= since < FOLLOW_UP_MIN:
            kind = "soon"
        else:
            continue
        if kind == "soon":
            label = "Вже час" if since > 0 else ("Нагадування" if remind > 60 else "Незабаром")
            when = ("завтра " if t["date"] == tomorrow else "") + f"о {t['time']}"
            left = ""
            if since < 0 and remind > 60:
                hh, mm = divmod(int(round(-since)), 60)
                left = " <i>(через " + " ".join(x for x in (f"{hh} год" if hh else "", f"{mm} хв" if mm else "") if x) + ")</i>"
            text = f"<b>{label}:</b> {escape(t['title'])} {when}{left}" + (
                f"\n<i>{escape(t['note'])}</i>" if t["note"] else "")
        else:
            text = (f"<b>Час минув:</b> {escape(t['title'])} о {t['time']}\n"
                    "Якщо вже зроблено — відміть ✓. Якщо ні — перенеси в Ritmoza.")
        try:
            await bot.send_message(user["chat_id"], text, reply_markup=reminder_keyboard(t, cfg.webapp_url or None))
        except TelegramForbiddenError:
            pass  # бота заблокировали — больше не пробуем
        except Exception:
            log.exception("Не удалось отправить напоминание %s, повторим через минуту", t["id"])
            continue
        await (db.mark_reminded(t["id"]) if kind == "soon" else db.mark_followed_up(t["id"]))

    # 3) Утром — план дня, хвосты и серии привычек (в пределах 3 часов от MORNING_HOUR, раз в день)
    if cfg.morning_hour <= now.hour < cfg.morning_hour + 3 and user["last_morning_date"] != today:
        tasks = await db.tasks_for_day(user["id"], today)
        overdue = await db.overdue(user["id"], today)
        habits = [h for h in await db.habits(user["id"]) if h["start_date"] <= today]
        if await _deliver(bot, user["chat_id"], morning_text(today, tasks, overdue, habits), kb):
            await db.set_last_morning(user["id"], today)

    # 4) Вечером — «Підсумки дня» одним сообщением (если есть что сказать)
    if now.hour >= cfg.evening_hour and user["last_evening_date"] != today:
        tasks = await db.tasks_for_day(user["id"], today)
        habits = await db.unmarked_habits(user["id"], today)
        tomorrow_empty = not await db.tasks_for_day(user["id"], tomorrow_of(today))
        text = evening_text(tasks, habits, tomorrow_empty)
        if not text or await _deliver(bot, user["chat_id"], text, kb):
            await db.set_last_evening(user["id"], today)


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
