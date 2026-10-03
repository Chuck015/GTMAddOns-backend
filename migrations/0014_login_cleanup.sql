-- Every login deletes expired sessions and challenges; without an index on expires that read every row of both
-- tables on every login. Also removes two tables nothing uses any more (leaderboard_snapshots, leaderboard_meta;
-- replaced by leaderboard_views in migration 0012).
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
CREATE INDEX IF NOT EXISTS challenges_expires ON challenges (expires);
DROP TABLE IF EXISTS leaderboard_snapshots;
DROP TABLE IF EXISTS leaderboard_meta;
