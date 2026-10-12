import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    bot_token: str
    webapp_url: str
    web_port: int
    default_tz: str
    evening_hour: int
    remind_before_min: int
    db_path: str
    dev_user_id: int | None


def load_config() -> Config:
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните.")
    dev = os.getenv("DEV_USER_ID", "").strip()
    return Config(
        bot_token=token,
        webapp_url=os.getenv("WEBAPP_URL", "").strip().rstrip("/"),
        web_port=int(os.getenv("WEB_PORT", "8080")),
        default_tz=os.getenv("DEFAULT_TZ", "Europe/Moscow"),
        evening_hour=int(os.getenv("EVENING_HOUR", "21")),
        remind_before_min=int(os.getenv("REMIND_BEFORE_MIN", "15")),
        db_path=os.getenv("DB_PATH", "planner.db"),
        dev_user_id=int(dev) if dev else None,
    )
