ALTER TABLE streaks ADD COLUMN lapse_count INTEGER CHECK (lapse_count > 0);
ALTER TABLE reports ADD COLUMN milestone INTEGER;
CREATE UNIQUE INDEX reports_milestone ON reports(user_id,milestone) WHERE milestone IS NOT NULL;
