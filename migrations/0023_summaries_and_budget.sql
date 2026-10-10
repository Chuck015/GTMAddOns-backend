-- 500 fights per category on the free plan (migration 0023).
--
-- D1 bills by rows read, so the stats views stop joining the child tables: each fight carries its totals as a short JSON
-- text (fights.summary, see src/summary.ts) and a view reads one row per fight. Fights stored before this have NULL and are
-- filled in by scripts/backfill-summaries.mjs (the worker also fills in any it meets).
ALTER TABLE fights ADD COLUMN summary TEXT;

-- Bumped when an admin deletes any of a player's data, so mods holding a copy of their fights start again (NULL = 0).
ALTER TABLE players ADD COLUMN data_epoch INTEGER;

-- How many fights a player has per category, so an upload knows whether anything must be pruned without counting.
CREATE TABLE IF NOT EXISTS fight_counts (
  uuid     TEXT    NOT NULL,
  category TEXT    NOT NULL,
  fights   INTEGER NOT NULL,
  PRIMARY KEY (uuid, category)
);
INSERT OR REPLACE INTO fight_counts (uuid, category, fights)
  SELECT uuid, category, COUNT(*) FROM fights WHERE category IS NOT NULL GROUP BY uuid, category;

-- "Fights stored after the last one I have" (GET /players/:uuid/fights?since=ID).
CREATE INDEX IF NOT EXISTS fights_uuid_id ON fights (uuid, id);
-- Opponent-filtered leaderboards read only the fights against the chosen names.
CREATE INDEX IF NOT EXISTS fights_category_opponent ON fights (category, lower(opponent));

-- Rows read and written per route and day (src/usage.ts); route '*' is the day's total.
CREATE TABLE IF NOT EXISTS usage_daily (
  day          TEXT    NOT NULL,
  route        TEXT    NOT NULL,
  requests     INTEGER NOT NULL,
  rows_read    INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  PRIMARY KEY (day, route)
);
