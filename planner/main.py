"""Точка входа: бот (long polling) + веб-сервер Mini App + напоминания в одном процессе."""
import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo
from aiohttp import web

from .api import build_app
from .bot import router
from .config import load_config
from .db import Database
from .reminders import reminder_loop

log = logging.getLogger("planner")


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()

    db = Database(cfg.db_path)
    await db.connect()

    bot = Bot(cfg.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(db=db, cfg=cfg)
    dp.include_router(router)

    await bot.set_my_commands([
        BotCommand(command="today", description="План на сьогодні"),
        BotCommand(command="add", description="Додати завдання на сьогодні"),
        BotCommand(command="tomorrow", description="Додати завдання на завтра"),
    ])
    if cfg.webapp_url:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="Планер", web_app=WebAppInfo(url=cfg.webapp_url))
        )
    else:
        log.warning("WEBAPP_URL не задан — Mini App будет недоступна из Telegram")

    runner = web.AppRunner(build_app(db, cfg))
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", cfg.web_port).start()
    log.info("Mini App: http://localhost:%s", cfg.web_port)

    reminders = asyncio.create_task(reminder_loop(bot, db, cfg))
    try:
        await dp.start_polling(bot)
    finally:
        reminders.cancel()
        await runner.cleanup()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
