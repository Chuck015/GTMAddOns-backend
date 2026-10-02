-- One counter the worker bumps when an admin deletes data, so cached leaderboards
-- (kept for minutes, shared across the data center) are dropped at once.
CREATE TABLE IF NOT EXISTS leaderboard_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT OR IGNORE INTO leaderboard_meta (k, v) VALUES ('version', 1);
