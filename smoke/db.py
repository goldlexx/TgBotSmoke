import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from .timeutil import instant, stamp, utcnow

MILESTONES = (1, 3, 7, 14, 30, 60, 90, 180, 365)
PROFILE_FIELDS = {"daily", "price", "currency", "pack", "minutes", "timezone", "report_time"}


class Database:
    def __init__(self, path: str):
        self.path = str(Path(path).resolve())
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
                    daily INTEGER NOT NULL, price TEXT NOT NULL, currency TEXT NOT NULL,
                    pack INTEGER NOT NULL, minutes TEXT NOT NULL,
                    timezone TEXT NOT NULL, report_time TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS streaks (
                    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(user_id),
                    start TEXT NOT NULL, end TEXT,
                    daily INTEGER NOT NULL, price TEXT NOT NULL, currency TEXT NOT NULL,
                    pack INTEGER NOT NULL, minutes TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_open_streak ON streaks(user_id) WHERE end IS NULL;
                CREATE INDEX IF NOT EXISTS streak_user ON streaks(user_id);
                CREATE TABLE IF NOT EXISTS achievements (
                    user_id INTEGER NOT NULL REFERENCES users(user_id), days INTEGER NOT NULL,
                    earned_at TEXT NOT NULL, PRIMARY KEY (user_id, days)
                );
                CREATE TABLE IF NOT EXISTS reports (
                    user_id INTEGER NOT NULL REFERENCES users(user_id), local_date TEXT NOT NULL,
                    status TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, local_date)
                );
                CREATE TABLE IF NOT EXISTS fsm (
                    key TEXT PRIMARY KEY, state TEXT, data TEXT NOT NULL DEFAULT '{}'
                );
            """)

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        try:
            with con:
                yield con
        finally:
            con.close()

    def user(self, user_id: int):
        with self.connect() as con:
            row = con.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()
            return dict(row) if row else None

    def users(self):
        with self.connect() as con:
            return [dict(r) for r in con.execute("SELECT * FROM users WHERE enabled=1")]

    def enabled(self, user_id: int, value: bool):
        with self.connect() as con:
            con.execute("UPDATE users SET enabled=? WHERE user_id=?", (int(value), user_id))

    @staticmethod
    def _new_streak(con, user_id: int, start: datetime, profile: dict):
        con.execute(
            "INSERT INTO streaks(user_id,start,daily,price,currency,pack,minutes) VALUES (?,?,?,?,?,?,?)",
            (user_id, stamp(start), *(profile[f] for f in ("daily", "price", "currency", "pack", "minutes"))),
        )

    @staticmethod
    def _award(con, user_id: int, streak, end: datetime):
        from datetime import timedelta

        start = instant(streak["start"])
        for days in MILESTONES:
            earned = start + timedelta(days=days)
            if earned <= end:
                con.execute(
                    "INSERT OR IGNORE INTO achievements VALUES (?,?,?)",
                    (user_id, days, stamp(earned)),
                )

    def register(self, user_id: int, chat_id: int, profile: dict, start: datetime):
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute(
                "INSERT INTO users(user_id,chat_id,daily,price,currency,pack,minutes,timezone,report_time) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (user_id, chat_id, *(profile[f] for f in ("daily", "price", "currency", "pack", "minutes", "timezone", "report_time"))),
            )
            self._new_streak(con, user_id, start, profile)

    def streaks(self, user_id: int):
        with self.connect() as con:
            return [dict(r) for r in con.execute("SELECT * FROM streaks WHERE user_id=? ORDER BY id", (user_id,))]

    def awards(self, user_id: int, now: datetime | None = None):
        now = now or utcnow()
        with self.connect() as con:
            for s in con.execute("SELECT * FROM streaks WHERE user_id=?", (user_id,)).fetchall():
                self._award(con, user_id, s, instant(s["end"]) if s["end"] else now)
            return {r["days"]: r["earned_at"] for r in con.execute("SELECT * FROM achievements WHERE user_id=?", (user_id,))}

    def change(self, user_id: int, field: str, value, now: datetime | None = None):
        if field not in PROFILE_FIELDS | {"start"}:
            raise ValueError("Неизвестная настройка.")
        now = now or utcnow()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            active = con.execute("SELECT * FROM streaks WHERE user_id=? AND end IS NULL", (user_id,)).fetchone()
            if field == "start":
                value = stamp(value)
                previous = con.execute("SELECT MAX(end) FROM streaks WHERE user_id=? AND end IS NOT NULL", (user_id,)).fetchone()[0]
                if previous and value < previous:
                    raise ValueError("Дата не может быть раньше окончания предыдущей серии.")
            self._award(con, user_id, active, now)
            if field == "start":
                con.execute("UPDATE streaks SET start=? WHERE id=? AND user_id=?", (value, active["id"], user_id))
            else:
                con.execute(f"UPDATE users SET {field}=? WHERE user_id=?", (value, user_id))
                if field in {"daily", "price", "currency", "pack", "minutes"}:
                    con.execute(f"UPDATE streaks SET {field}=? WHERE id=? AND user_id=?", (value, active["id"], user_id))

    def lapse(self, user_id: int, streak_id: int, began: datetime, last: datetime):
        if last < began or last > utcnow():
            raise ValueError("Последняя сигарета должна быть не раньше начала срыва и не в будущем.")
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            active = con.execute("SELECT * FROM streaks WHERE user_id=? AND end IS NULL", (user_id,)).fetchone()
            if active["id"] != streak_id:
                raise ValueError("Серия уже изменилась. Откройте настройки заново.")
            if began < instant(active["start"]):
                raise ValueError("Начало срыва не может быть раньше начала текущей серии.")
            self._award(con, user_id, active, began)
            con.execute("UPDATE streaks SET end=? WHERE id=? AND user_id=?", (stamp(began), streak_id, user_id))
            profile = dict(con.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone())
            self._new_streak(con, user_id, last, profile)

    def change_cost(self, user_id: int, cost: dict):
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            active = con.execute("SELECT * FROM streaks WHERE user_id=? AND end IS NULL", (user_id,)).fetchone()
            self._award(con, user_id, active, utcnow())
            args = (cost["price"], cost["currency"], user_id)
            con.execute("UPDATE users SET price=?,currency=? WHERE user_id=?", args)
            con.execute("UPDATE streaks SET price=?,currency=? WHERE user_id=? AND end IS NULL", args)

    def claim_report(self, user_id: int, local_date: str) -> bool:
        # Резервируем ДО сетевого запроса: неизвестный результат отправки не повторяем.
        with self.connect() as con:
            return con.execute(
                "INSERT OR IGNORE INTO reports VALUES (?,?,'reserved',?)",
                (user_id, local_date, stamp(utcnow())),
            ).rowcount == 1

    def finish_report(self, user_id: int, local_date: str, status: str):
        with self.connect() as con:
            con.execute("UPDATE reports SET status=? WHERE user_id=? AND local_date=?", (status, user_id, local_date))

    def release_report(self, user_id: int, local_date: str):
        with self.connect() as con:
            con.execute("DELETE FROM reports WHERE user_id=? AND local_date=? AND status='reserved'", (user_id, local_date))

    def fsm_get(self, key: str):
        with self.connect() as con:
            row = con.execute("SELECT state,data FROM fsm WHERE key=?", (key,)).fetchone()
            return (row["state"], json.loads(row["data"])) if row else (None, {})

    def fsm_set(self, key: str, field: str, value):
        if field not in {"state", "data"}:
            raise ValueError(field)
        if field == "data":
            value = json.dumps(value, ensure_ascii=False)
        with self.connect() as con:
            con.execute("INSERT OR IGNORE INTO fsm(key) VALUES (?)", (key,))
            con.execute(f"UPDATE fsm SET {field}=? WHERE key=?", (value, key))
            con.execute("DELETE FROM fsm WHERE key=? AND state IS NULL AND data='{}'", (key,))
