
                
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
            
CREATE TABLE IF NOT EXISTS cloud_control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO cloud_control VALUES ('active','0');
CREATE TABLE IF NOT EXISTS webhook_updates (update_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_locks (user_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS report_retries (user_id INTEGER NOT NULL, local_date TEXT NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(user_id,local_date));
