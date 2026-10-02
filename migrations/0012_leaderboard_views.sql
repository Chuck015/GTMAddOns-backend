-- Every leaderboard view (category, number of fights, opponent filter) stored as finished JSON,
-- replacing leaderboard_snapshots (no opponent filter only) and the Cloudflare cache, which does
-- nothing on workers.dev. Rows unused for an hour are deleted when a view is stored.
CREATE TABLE IF NOT EXISTS leaderboard_views (
  key         TEXT PRIMARY KEY,
  body        TEXT    NOT NULL,
  computed_at INTEGER NOT NULL
);
