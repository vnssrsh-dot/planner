"""Команды и кнопки Telegram-бота."""
import re
from html import escape
from datetime import date

from aiogram import F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import CallbackQuery, Message

from .config import Config
from .db import Database
from .timeutil import human_day, local_now, tomorrow_of
from .views import day_text, tasks_keyboard

router = Router()

TIME_RE = re.compile(r"^(\d{1,2})[:.](\d{2})$")


async def _today(db: Database, cfg: Config, user_id: int) -> str:
    user = await db.get_user(user_id)
    return local_now(user["tz"] if user else None, cfg.default_tz).date().isoformat()


async def send_day(message: Message, db: Database, cfg: Config, user_id: int) -> None:
    today = await _today(db, cfg, user_id)
    tasks = await db.tasks_for_day(user_id, today)
    overdue = await db.overdue(user_id, today)
    await message.answer(
        day_text(today, tasks, overdue),
        reply_markup=tasks_keyboard(tasks, cfg.webapp_url or None),
    )


@router.message(CommandStart())
async def cmd_start(message: Message, db: Database, cfg: Config) -> None:
    u = message.from_user
    await db.upsert_user(u.id, chat_id=message.chat.id, first_name=u.first_name)
    await message.answer(
        f"Привіт, {u.first_name}!\n\n"
        "Я — планер справ. Щодня показую план, а ввечері нагадаю про те, що ще не зроблено.\n\n"
        "• <b>Відкрити планер</b> — календар, додавання і редагування завдань\n"
        "• /today — план на сьогодні\n"
        "• /add 18:30 Зателефонувати мамі — додати завдання на сьогодні\n"
        "• /tomorrow Купити хліб — додати на завтра"
    )
    await send_day(message, db, cfg, u.id)


@router.message(Command("today"))
async def cmd_today(message: Message, db: Database, cfg: Config) -> None:
    await db.upsert_user(message.from_user.id, chat_id=message.chat.id)
    await send_day(message, db, cfg, message.from_user.id)


def _parse_quick(text: str) -> tuple[str | None, str]:
    """'18:30 Зателефонувати мамі' -> ('18:30', 'Зателефонувати мамі')."""
    parts = text.strip().split(maxsplit=1)
    if parts and (m := TIME_RE.match(parts[0])):
        h, mnt = int(m[1]), int(m[2])
        if h < 24 and mnt < 60:
            return f"{h:02d}:{mnt:02d}", parts[1].strip() if len(parts) > 1 else ""
    return None, text.strip()


async def _quick_add(message: Message, command: CommandObject, db: Database, cfg: Config, shift: int) -> None:
    uid = message.from_user.id
    await db.upsert_user(uid, chat_id=message.chat.id)
    time, title = _parse_quick(command.args or "")
    if not title:
        await message.answer(f"Напишіть завдання після команди, наприклад:\n/{command.command} 18:30 Зателефонувати мамі")
        return
    day = await _today(db, cfg, uid)
    if shift:
        day = tomorrow_of(day)
    await db.create_task(uid, date=day, time=time, title=title[:200])
    when = f" о {time}" if time else ""
    await message.answer(f"Додано на {human_day(day)}{when}: <b>{escape(title)}</b>")


@router.message(Command("add"))
async def cmd_add(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    await _quick_add(message, command, db, cfg, 0)


@router.message(Command("tomorrow"))
async def cmd_tomorrow(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    await _quick_add(message, command, db, cfg, 1)


async def _refresh(cb: CallbackQuery, db: Database, cfg: Config) -> None:
    """Перерисовать сообщение со списком после изменения задачи."""
    uid = cb.from_user.id
    today = await _today(db, cfg, uid)
    tasks = await db.tasks_for_day(uid, today)
    overdue = await db.overdue(uid, today)
    with_tomorrow = any(
        b.callback_data and b.callback_data.startswith("tmrw:")
        for row in (cb.message.reply_markup.inline_keyboard if cb.message.reply_markup else [])
        for b in row
    )
    try:
        await cb.message.edit_text(
            day_text(today, tasks, overdue),
            reply_markup=tasks_keyboard(tasks, cfg.webapp_url or None, with_tomorrow=with_tomorrow),
        )
    except Exception:  # сообщение не изменилось или слишком старое
        pass


@router.callback_query(F.data.startswith("done:"))
async def cb_done(cb: CallbackQuery, db: Database, cfg: Config) -> None:
    task = await db.update_task(cb.from_user.id, int(cb.data.split(":")[1]), done=True)
    await cb.answer(f"Виконано: {task['title']}" if task else "Завдання не знайдено")
    await _refresh(cb, db, cfg)


@router.callback_query(F.data.startswith("tmrw:"))
async def cb_tomorrow(cb: CallbackQuery, db: Database, cfg: Config) -> None:
    uid = cb.from_user.id
    tomorrow = tomorrow_of(await _today(db, cfg, uid))
    task = await db.update_task(uid, int(cb.data.split(":")[1]), date=tomorrow)
    await cb.answer("Перенесено на завтра" if task else "Завдання не знайдено")
    await _refresh(cb, db, cfg)
