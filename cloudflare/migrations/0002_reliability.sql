-- Additive migration: old rows and historical report ledger are preserved.
ALTER TABLE users ADD COLUMN next_due_at INTEGER;
CREATE INDEX users_due ON users(next_due_at, user_id) WHERE enabled=1;
-- A one-time, bounded bootstrap computes each existing user's IANA/DST schedule.
CREATE INDEX users_unscheduled ON users(user_id) WHERE enabled=1 AND next_due_at IS NULL;
CREATE INDEX webhook_created ON webhook_updates(created_at);
ALTER TABLE webhook_updates ADD COLUMN user_id INTEGER;
CREATE INDEX webhook_user ON webhook_updates(user_id);
ALTER TABLE reports ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE TABLE delivery_outbox (
  id INTEGER PRIMARY KEY, update_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL, method TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready', due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(update_id, sequence)
);
CREATE INDEX outbox_due ON delivery_outbox(due_at,id) WHERE status IN ('ready','retry','sending');
CREATE INDEX outbox_user ON delivery_outbox(user_id);
CREATE INDEX outbox_created ON delivery_outbox(created_at);
CREATE TABLE deleted_accounts (subject TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
CREATE TABLE rate_limits (subject TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX rate_window ON rate_limits(window);
