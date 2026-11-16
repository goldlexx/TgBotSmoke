import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.base import BaseSession
from aiogram.enums import ParseMode
from aiogram.fsm.storage.base import StorageKey
from aiogram.fsm.storage.memory import SimpleEventIsolation
from aiogram.methods import AnswerCallbackQuery, EditMessageReplyMarkup, SendMessage
from aiogram.types import CallbackQuery, Chat, Message, Update, User

from smoke.db import Database
from smoke.handlers import build_router, numeric, parse_field
from smoke.scheduler import Reports, due_date
from smoke.stats import calculate, report
from smoke.storage import SQLiteStorage
from smoke.timeutil import instant, local_input

PROFILE = dict(daily=20, price="250", currency="RUB", pack=20, minutes="5", timezone="Europe/Moscow", report_time="08:00")


class DatabaseCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self.temp.name) / "test.sqlite3"))

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_totals_and_restart_isolation(self):
        now = datetime(2026, 11, 16, 9, tzinfo=UTC)
        self.db.register(1, 1, PROFILE, now - timedelta(days=3, hours=12))
        self.db.register(2, 2, PROFILE, now)
        reopened = Database(self.db.path)
        s = calculate(reopened.streaks(1), now)
        self.assertEqual(s.current_seconds, 302400)
        self.assertEqual(s.cigarettes, Decimal(70))
        self.assertEqual(s.money, {"RUB": Decimal(875)})
        self.assertEqual(s.free_minutes, Decimal(350))
        self.assertEqual(s.life_minutes, Decimal(1400))
        self.assertEqual(calculate(reopened.streaks(2), now).cigarettes, 0)

    def test_lapse_excludes_smoking_gap_and_preserves_awards(self):
        now = datetime.now(UTC)
        self.db.register(1, 1, PROFILE, now - timedelta(days=10))
        active = self.db.streaks(1)[-1]
        began, last = now - timedelta(days=3), now - timedelta(days=1)
        self.db.lapse(1, active["id"], began, last)
        s = calculate(self.db.streaks(1), now)
        self.assertEqual(s.current_seconds, 86400)
        self.assertEqual(s.total_seconds, 8 * 86400)
        self.assertEqual(s.cigarettes, 160)
        self.assertEqual(set(self.db.awards(1, now)), {1, 3, 7})
        with self.assertRaises(ValueError):
            self.db.lapse(1, active["id"], began, last)
        with self.assertRaises(ValueError):
            self.db.change(1, "start", began - timedelta(days=1))
        self.assertEqual(len(self.db.streaks(1)), 2)

    def test_currency_changes_keep_closed_period(self):
        now = datetime.now(UTC)
        self.db.register(1, 1, PROFILE, now - timedelta(days=4))
        self.db.lapse(1, self.db.streaks(1)[0]["id"], now - timedelta(days=2), now - timedelta(days=1))
        self.db.change_cost(1, {"price": "5", "currency": "EUR"})
        self.assertEqual(calculate(self.db.streaks(1), now).money, {"RUB": Decimal(500), "EUR": Decimal(5)})

    def test_report_claim_persists_and_text_varies(self):
        now = datetime.now(UTC)
        self.db.register(1, 1, PROFILE, now - timedelta(days=2))
        self.assertTrue(self.db.claim_report(1, "2026-11-16"))
        self.assertFalse(Database(self.db.path).claim_report(1, "2026-11-16"))
        self.assertTrue(self.db.claim_report(1, "2026-11-17"))
        first = report(self.db.streaks(1), now, now.date(), 1, True)
        second = report(self.db.streaks(1), now, (now + timedelta(days=1)).date(), 1, True)
        self.assertNotEqual(first, second)
        self.assertIn("а не обещание", first)
        self.assertLess(len(first), 4096)


class TimeCase(unittest.TestCase):
    def test_timezone_future_dst(self):
        now = datetime(2026, 11, 16, 9, tzinfo=UTC)
        self.assertEqual(local_input("15.11.2026 12:00", "Europe/Moscow", now), now - timedelta(days=1))
        for value in ("17.11.2026 12:00", "не дата"):
            with self.assertRaises(ValueError):
                local_input(value, "Europe/Moscow", now)
        for value in ("29.03.2026 02:30", "25.10.2026 02:30"):
            with self.assertRaises(ValueError):
                local_input(value, "Europe/Berlin", now)
        self.assertEqual(local_input("25.10.2026 02:30 +0200", "Europe/Berlin", now).hour, 0)
        self.assertEqual(local_input("25.10.2026 02:30 +0100", "Europe/Berlin", now).hour, 1)

    def test_validation_and_local_schedule(self):
        for value in ("0", "201", "NaN", "1.5", "-2"):
            with self.assertRaises(ValueError):
                numeric(value, "1", "200", True)
        self.assertEqual(parse_field("cost", "250,50 RUB", "Europe/Moscow"), {"price": "250.50", "currency": "RUB"})
        self.assertIsNone(due_date(PROFILE, datetime(2026, 11, 16, 4, 59, tzinfo=UTC)))
        self.assertEqual(due_date(PROFILE, datetime(2026, 11, 16, 5, tzinfo=UTC)), "2026-11-16")
        berlin = {**PROFILE, "timezone": "Europe/Berlin", "report_time": "02:30"}
        self.assertEqual(due_date(berlin, datetime(2026, 3, 29, 1, tzinfo=UTC)), "2026-03-29")


class OfflineSession(BaseSession):
    """Все обращения Telegram перехватываются: внешней сети в тестах нет."""
    def __init__(self):
        super().__init__()
        self.messages = []

    async def close(self):
        pass

    async def make_request(self, bot, method, timeout=None):
        if isinstance(method, SendMessage):
            self.messages.append(method.text)
            return Message(message_id=len(self.messages), date=datetime.now(UTC), chat=Chat(id=int(method.chat_id), type="private"), text=method.text)
        if isinstance(method, (AnswerCallbackQuery, EditMessageReplyMarkup)):
            return True
        raise AssertionError(f"Unexpected method: {type(method).__name__}")

    async def stream_content(self, *args, **kwargs):
        if False:
            yield b""


class AsyncCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self.temp.name) / "test.sqlite3"))

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_scheduler_no_duplicate_after_restart_and_failure(self):
        now = datetime(2026, 11, 16, 9, tzinfo=UTC)
        self.db.register(1, 1, PROFILE, now - timedelta(days=3))
        self.db.register(2, 2, PROFILE, now - timedelta(days=3))
        bot = AsyncMock()
        bot.send_message.side_effect = [TimeoutError(), None, None, None]
        await Reports(self.db, bot).tick(now)
        self.assertEqual(bot.send_message.await_count, 2)
        await Reports(Database(self.db.path), bot).tick(now)
        self.assertEqual(bot.send_message.await_count, 2)
        await Reports(self.db, bot).tick(now + timedelta(days=1))
        self.assertEqual(bot.send_message.await_count, 4)

    async def test_registration_resume_offline(self):
        session = OfflineSession()
        bot = Bot("123456:offline-test-token", session=session, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
        storage = SQLiteStorage(self.db)
        dp = Dispatcher(storage=storage, events_isolation=SimpleEventIsolation())
        dp.include_router(build_router(self.db))
        seq = 0

        async def send(text):
            nonlocal seq
            seq += 1
            msg = Message(message_id=seq, date=datetime.now(UTC), chat=Chat(id=42, type="private"), from_user=User(id=42, is_bot=False, first_name="Тест"), text=text)
            await dp.feed_update(bot, Update(update_id=seq, message=msg))

        await send("/start")
        await send("01.01.2026 10:00")
        await send("20")
        # Новый storage читает незавершённый диалог из той же SQLite.
        restored = SQLiteStorage(Database(self.db.path))
        key = StorageKey(bot_id=123456, chat_id=42, user_id=42)
        self.assertEqual((await restored.get_data(key))["field"], "cost")
        await send("/start")
        await send("250 RUB")
        await send("20")
        await send("5")
        await send("Europe/Moscow")
        await send("25:99")
        self.assertIsNone(self.db.user(42))
        await send("08:00")
        self.assertEqual(self.db.user(42)["report_time"], "08:00")
        self.assertEqual(instant(self.db.streaks(42)[0]["start"]), datetime(2026, 1, 1, 7, tzinfo=UTC))
        await send("🫁 Моё здоровье")
        self.assertLess(len(session.messages[-1]), 4096)
        self.assertIsNone(await restored.get_state(key))
        # Проходим отметку срыва через реальные фильтры роутера и FSM.
        async def callback(data):
            nonlocal seq
            seq += 1
            msg = Message(message_id=500, date=datetime.now(UTC), chat=Chat(id=42, type="private"), text="Настройки")
            cb = CallbackQuery(id=str(seq), from_user=User(id=42, is_bot=False, first_name="Тест"), chat_instance="offline", message=msg, data=data)
            await dp.feed_update(bot, Update(update_id=seq, callback_query=cb))

        await callback("lapse")
        await send("Сейчас")
        await send("Одна сигарета")
        draft = await restored.get_data(key)
        await callback("lapse:confirm:outdated")
        self.assertEqual(len(self.db.streaks(42)), 1)
        await callback("lapse:confirm:" + draft["nonce"])
        self.assertEqual(len(self.db.streaks(42)), 2)
        await callback("lapse:confirm:" + draft["nonce"])
        self.assertEqual(len(self.db.streaks(42)), 2)
        await callback("edit:cost")
        await send("6 EUR")
        self.assertEqual(self.db.user(42)["currency"], "EUR")
        await storage.close()
        await bot.session.close()


if __name__ == "__main__":
    unittest.main()
