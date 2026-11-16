import json

from aiogram.fsm.state import State
from aiogram.fsm.storage.base import BaseStorage, StorageKey

from .db import Database


class SQLiteStorage(BaseStorage):
    """Диалоги переживают рестарт. SimpleEventIsolation сериализует ввод одного пользователя."""
    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def key(key: StorageKey) -> str:
        return json.dumps([key.bot_id, key.chat_id, key.user_id, key.thread_id, key.business_connection_id, key.destiny])

    async def set_state(self, key: StorageKey, state: str | State | None = None):
        self.db.fsm_set(self.key(key), "state", state.state if isinstance(state, State) else state)

    async def get_state(self, key: StorageKey):
        return self.db.fsm_get(self.key(key))[0]

    async def set_data(self, key: StorageKey, data: dict):
        self.db.fsm_set(self.key(key), "data", data)

    async def get_data(self, key: StorageKey):
        return self.db.fsm_get(self.key(key))[1]

    async def close(self):
        pass
