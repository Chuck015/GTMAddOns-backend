-- Cut D1 "rows read": the leaderboard, the per-fight deletes and the upload trimming look
-- these tables up by fight (and fights by category), which had no index, so every lookup
-- scanned the whole table. Indexes only; no data changes.
CREATE INDEX IF NOT EXISTS fight_guns_fight ON fight_guns (fight_id);
CREATE INDEX IF NOT EXISTS fight_combos_fight ON fight_combos (fight_id);
CREATE INDEX IF NOT EXISTS fights_category_uuid_ended ON fights (category, uuid, ended_at);
