from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def safe_zone(tz: str | None, default: str) -> ZoneInfo:
    for name in (tz, default, "UTC"):
        if not name:
            continue
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return ZoneInfo("UTC")


def local_now(tz: str | None, default: str) -> datetime:
    return datetime.now(safe_zone(tz, default))


def iso(d: date) -> str:
    return d.isoformat()


def tomorrow_of(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]


def human_day(day: str) -> str:
    d = date.fromisoformat(day)
    return f"{WEEKDAYS[d.weekday()]}, {d.day} {MONTHS_GEN[d.month - 1]}"
