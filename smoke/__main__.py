import asyncio
import logging
import os
import sys
from contextlib import contextmanager
from pathlib import Path

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramUnauthorizedError
from aiogram.fsm.storage.memory import SimpleEventIsolation
from aiogram.types import BotCommand, LinkPreviewOptions
from aiogram.utils.token import TokenValidationError
from dotenv import load_dotenv

from .db import Database
from .handlers import build_router
from .scheduler import Reports
from .storage import SQLiteStorage

ROOT = Path(__file__).resolve().parent.parent


@contextmanager
def instance_lock(path: str):
    lock_path = Path(path + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("Бот уже запущен с этой базой. Закройте второй экземпляр.") from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


async def run(token: str, path: str):
    db = Database(path)
    bot = Bot(token, default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview=LinkPreviewOptions(is_disabled=True)))
    dp = Dispatcher(storage=SQLiteStorage(db), events_isolation=SimpleEventIsolation())
    dp.include_router(build_router(db))
    scheduler = None
    try:
        await bot.get_me()
        await bot.delete_webhook(drop_pending_updates=False)
        await bot.set_my_commands([
            BotCommand(command="start", description="Начать или открыть меню"),
            BotCommand(command="cancel", description="Отменить текущий ввод"),
        ])
        scheduler = Reports(db, bot).start()
        logging.getLogger(__name__).info("Бот запущен. Для остановки нажмите Ctrl+C.")
        await dp.start_polling(bot, close_bot_session=False, allowed_updates=dp.resolve_used_update_types())
    finally:
        if scheduler is not None:
            scheduler.shutdown(wait=False)
            await asyncio.sleep(0)
        await dp.storage.close()
        await bot.session.close()


def main() -> int:
    if sys.version_info < (3, 12):
        print("Нужен Python 3.12 или новее.", file=sys.stderr)
        return 1
    load_dotenv(ROOT / ".env")
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        print("Заполните BOT_TOKEN в .env (образец: .env.example). Подключение к Telegram не выполнялось.", file=sys.stderr)
        return 1
    path = Path(os.getenv("DATABASE_PATH", "data/smoke.sqlite3"))
    if not path.is_absolute():
        path = ROOT / path
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Библиотеки не должны выводить сетевые URL и содержимое обновлений.
    logging.getLogger("aiogram").setLevel(logging.CRITICAL)
    logging.getLogger("aiohttp").setLevel(logging.CRITICAL)
    try:
        with instance_lock(str(path.resolve())):
            asyncio.run(run(token, str(path)))
    except (TokenValidationError, TelegramUnauthorizedError):
        print("BOT_TOKEN некорректен или отозван. Проверьте .env.", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, SystemExit):
        return 0
    except Exception as exc:
        print(f"Не удалось запустить бот ({type(exc).__name__}). Проверьте сеть, путь базы и отсутствие второго экземпляра.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
