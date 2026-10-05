-- Leaderboard rows per player (migration 0015).
--
-- A leaderboard view used to be computed from scratch for every player at once (tens of thousands of rows read).
-- Now each player's entry for each view size (25 / 50 / 100 fights) of each PvP category is kept as finished JSON in
-- leaderboard_rows, and only rebuilt when that player's fights in that category changed (leaderboard_dirty, set when a
-- fight is uploaded or an admin deletes one). Views filtered by opponents or with another fight count still use the
-- full computation.
CREATE TABLE IF NOT EXISTS leaderboard_rows (
  uuid     TEXT    NOT NULL,
  category TEXT    NOT NULL,
  n        INTEGER NOT NULL,
  row      TEXT    NOT NULL,
  built_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, category, n)
);

CREATE INDEX IF NOT EXISTS leaderboard_rows_view ON leaderboard_rows (category, n);

CREATE TABLE IF NOT EXISTS leaderboard_dirty (
  uuid      TEXT    NOT NULL,
  category  TEXT    NOT NULL,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, category)
);

-- Everyone starts dirty: their rows are built the first time a leaderboard asks.
INSERT OR IGNORE INTO leaderboard_dirty (uuid, category, marked_at)
  SELECT DISTINCT uuid, category, 0 FROM fights WHERE category IS NOT NULL;
