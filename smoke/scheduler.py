import asyncio
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .db import Database
from .stats import report
from .timeutil import utcnow
from .ui import menu

logger = logging.getLogger(__name__)


def due_date(user: dict, now: datetime) -> str | None:
    local = now.astimezone(ZoneInfo(user["timezone"]))
    # Сравнение местных часов также обрабатывает пропуск времени при переходе на летнее.
    # При повторении часа UNIQUE(user_id, local_date) не даёт отправить второй отчёт.
    if local.strftime("%H:%M") >= user["report_time"]:
        return local.date().isoformat()
    return None


class Reports:
    def __init__(self, db: Database, bot: Bot):
        self.db, self.bot = db, bot
        self.retry_at: dict[int, datetime] = {}
        self._lock = asyncio.Lock()

    async def tick(self, now: datetime | None = None):
        async with self._lock:
            now = now or utcnow()
            for user in self.db.users():
                user_id = user["user_id"]
                try:
                    local_date = due_date(user, now)
                    if not local_date or now < self.retry_at.get(user_id, now):
                        continue
                    if self.db.report_processed(user_id, local_date):
                        continue
                    self.db.awards(user_id, now)
                    # Сначала готовим текст, чтобы локальная ошибка не занимала слот отправки.
                    text = report(self.db.streaks(user_id), now, datetime.fromisoformat(local_date).date(), user_id, morning=True)
                    if not self.db.claim_report(user_id, local_date):
                        continue
                    try:
                        await self.bot.send_message(user["chat_id"], text, reply_markup=menu())
                    except TelegramRetryAfter as exc:
                        # Telegram явно отклонил запрос — можно повторить после указанной паузы.
                        self.retry_at[user_id] = now + timedelta(seconds=exc.retry_after + 1)
                        self.db.release_report(user_id, local_date)
                    except TelegramForbiddenError:
                        self.db.enabled(user_id, False)
                        self.db.finish_report(user_id, local_date, "blocked")
                    except TelegramBadRequest:
                        self.db.finish_report(user_id, local_date, "rejected")
                        logger.error("Отчёт отклонён Telegram, user_id=%s", user_id)
                    except Exception as exc:
                        self.db.finish_report(user_id, local_date, "unknown")
                        logger.warning("Результат отправки неизвестен, user_id=%s, ошибка=%s", user_id, type(exc).__name__)
                    else:
                        self.retry_at.pop(user_id, None)
                        self.db.finish_report(user_id, local_date, "sent")
                except Exception as exc:
                    logger.error("Ошибка планировщика, user_id=%s, тип=%s", user_id, type(exc).__name__)

    def start(self) -> AsyncIOScheduler:
        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(self.tick, "interval", seconds=30, id="morning-reports", max_instances=1, coalesce=True, misfire_grace_time=60, next_run_time=utcnow())
        scheduler.start()
        return scheduler
