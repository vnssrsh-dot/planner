"""Тексты и клавиатуры бота (используются и командами, и напоминаниями)."""
from html import escape

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from datetime import date, timedelta

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
        rows.append([InlineKeyboardButton(text="Відкрити Ritmoza", web_app=WebAppInfo(url=webapp_url))])
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


# ---------- утренняя сводка ----------

def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def habit_streak(h: dict, day: str) -> int:
    marks = set(h["marks"])
    d = date.fromisoformat(day)
    if day not in marks:
        d -= timedelta(days=1)
    n = 0
    while d.isoformat() in marks:
        n += 1
        d -= timedelta(days=1)
    return n


def habit_best(h: dict) -> int:
    best = run = 0
    prev = None
    for s in sorted(h["marks"]):
        d = date.fromisoformat(s)
        run = run + 1 if prev and d - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = d
    return best


def _habit_line(h: dict, day: str) -> str:
    quit_ = h["kind"] == "quit"
    streak, best = habit_streak(h, day), habit_best(h)
    title = f"<b>{escape(h['title'])}</b>" + (" <i>(позбуваюсь)</i>" if quit_ else "")
    if not streak:
        return f"• {title} — " + ("сьогодні новий старт, тримайся" if quit_ else "почни нову серію сьогодні")
    word = _plural(streak, "день", "дні", "днів")
    days = f"{streak} {word} без зривів" if quit_ else f"{streak} {word} поспіль"
    record = " · новий рекорд 🔥" if streak >= best and streak > 1 else (f" · рекорд {best}" if best > streak else "")
    return f"• {title} — {days}{record}"


def morning_text(day: str, tasks: list[dict], overdue: list[dict], habits: list[dict]) -> str:
    open_tasks = [t for t in tasks if not t["done"]]
    lines = [f"<b>Доброго ранку! План на {human_day(day)}</b>", ""]
    lines += [task_line(t) for t in open_tasks] or ["На сьогодні план ще порожній. Додай 1–3 головні справи — і день складеться легше."]
    if overdue:
        lines += ["", f"<b>Не виконано раніше: {len(overdue)}</b>"]
        lines += [task_line(t) + f" <i>({t['date'][8:]}.{t['date'][5:7]})</i>" for t in overdue[:5]]
    if habits:
        lines += ["", "<b>Звички</b>", *[_habit_line(h, day) for h in habits]]
        best = max(habit_streak(h, day) for h in habits)
        lines += ["", "Серії ростуть — не відпускай їх сьогодні." if best >= 3 else "Маленький крок щодня — і звичка складеться."]
    else:
        lines += ["", "Гарного дня!"]
    return "\n".join(lines)


def open_keyboard(webapp_url: str | None, hash_: str = "") -> InlineKeyboardMarkup | None:
    """Под всеми сообщениями — только «Відкрити Ritmoza»: дела меняют в приложении."""
    if not webapp_url:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Відкрити Ritmoza", web_app=WebAppInfo(url=webapp_url + hash_))
    ]])


def invite_text(hour: int, first_name: str | None) -> str:
    """Приглашение через 30 минут после знакомства, если человек ничего не добавил."""
    if 4 <= hour < 12:
        name = f", {escape(first_name)}" if first_name else ""
        return "\n".join([
            f"<b>Доброго ранку{name}!</b> ☀️",
            "",
            "Ritmoza готова допомогти спланувати день.",
            "Почни з малого: додай 2–3 справи на сьогодні — я нагадаю про них вчасно, а ввечері підкажу, що ще лишилось.",
            "",
            "Можна завести й звичку — наприклад, «пити воду» чи «зарядка», — і я рахуватиму твої серії.",
            "",
            "<i>Швидко з чату: /add 18:30 Зателефонувати мамі</i>",
        ])
    if 12 <= hour < 19:
        return "\n".join([
            "<b>Ще пів дня попереду</b> ☀️",
            "",
            "Запиши, що хочеш встигнути сьогодні — я нагадаю за 15 хвилин до кожної справи, а о 21:00 підкажу, що лишилось.",
            "",
            "<i>Або з чату: /add 18:30 Зателефонувати мамі</i>",
        ])
    return "\n".join([
        "<b>Вечір — гарний час, щоб спланувати завтра</b> 🌙",
        "",
        "Додай 2–3 справи на завтра — зранку я пришлю план, а за 15 хвилин до кожної справи нагадаю.",
        "",
        "<i>Або з чату: /tomorrow Купити хліб</i>",
    ])


def evening_text(tasks: list[dict], habits: list[dict], tomorrow_empty: bool) -> str | None:
    """21:00 — одно сообщение «Підсумки дня»; None, если сказать нечего."""
    open_tasks = [t for t in tasks if not t["done"]]
    blocks = []
    if open_tasks:
        blocks.append("\n".join([f"<b>Не виконано: {len(open_tasks)}</b>", *map(task_line, open_tasks)]))
    if habits:
        blocks.append("\n".join(["<b>Звички ще не відмічені</b>", *(
            f"• {'без зриву: ' if h['kind'] == 'quit' else ''}{escape(h['title'])}" for h in habits)]))
    if tomorrow_empty:
        blocks.append("<b>Завтра поки нічого не заплановано</b> — додай справи, і зранку я пришлю план.")
    if not blocks:
        return None
    if not open_tasks and tasks:
        blocks.insert(0, "Усе заплановане на сьогодні виконано 🎉")
    return "\n\n".join(["<b>Підсумки дня</b> 🌙", *blocks])
