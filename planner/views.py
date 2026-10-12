"""Тексты и клавиатуры бота (используются и командами, и напоминаниями)."""
from html import escape

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from .timeutil import human_day


def task_line(t: dict) -> str:
    time = f"<b>{t['time']}</b> " if t["time"] else ""
    return f"• {time}{escape(t['title'])}"


def day_text(day: str, tasks: list[dict], overdue: list[dict] | None = None) -> str:
    lines = [f"<b>План на {human_day(day)}</b>", ""]
    open_tasks = [t for t in tasks if not t["done"]]
    done = len(tasks) - len(open_tasks)
    if open_tasks:
        lines += [task_line(t) for t in open_tasks]
    elif tasks:
        lines.append("Усе виконано.")
    else:
        lines.append("Планів немає. Додайте завдання в планері або командою /add.")
    if done:
        lines += ["", f"Виконано: {done} з {len(tasks)}"]
    if overdue:
        lines += ["", f"<b>Не виконано раніше: {len(overdue)}</b>"]
        lines += [task_line(t) + f" <i>({t['date'][8:]}.{t['date'][5:7]})</i>" for t in overdue[:5]]
    return "\n".join(lines)


def tasks_keyboard(
    tasks: list[dict], webapp_url: str | None, *, with_tomorrow: bool = False,
) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    for t in tasks:
        if t["done"]:
            continue
        title = t["title"] if len(t["title"]) <= 28 else t["title"][:27] + "…"
        row = [InlineKeyboardButton(text=f"✓ {title}", callback_data=f"done:{t['id']}")]
        if with_tomorrow:
            row.append(InlineKeyboardButton(text="→ Завтра", callback_data=f"tmrw:{t['id']}"))
        rows.append(row)
    if webapp_url:
        rows.append([InlineKeyboardButton(text="Відкрити планер", web_app=WebAppInfo(url=webapp_url))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def habits_text(habits: list[dict]) -> str:
    lines = ["<b>Звички, які сьогодні ще не відмічені</b>", ""]
    for h in habits:
        prefix = "без зриву: " if h["kind"] == "quit" else ""
        lines.append(f"• {prefix}{escape(h['title'])}")
    lines += ["", "Відмітьте, якщо вже зробили — серія не перерветься."]
    return "\n".join(lines)


def habits_keyboard(habits: list[dict], day: str, webapp_url: str | None) -> InlineKeyboardMarkup:
    rows = []
    for h in habits:
        title = h["title"] if len(h["title"]) <= 30 else h["title"][:29] + "…"
        rows.append([InlineKeyboardButton(text=f"✓ {title}", callback_data=f"habit:{h['id']}:{day}")])
    if webapp_url:
        rows.append([InlineKeyboardButton(text="Відкрити звички", web_app=WebAppInfo(url=webapp_url + "#habits"))])
    return InlineKeyboardMarkup(inline_keyboard=rows)
