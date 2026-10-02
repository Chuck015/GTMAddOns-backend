-- Ready-made leaderboards. The worker stores the finished JSON for each (category, number of
-- fights) view with no opponent filter, so opening it costs one row read instead of the
-- whole ranking query. Rebuilt on demand once it is older than five minutes, and wiped when
-- an admin deletes data.
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  category    TEXT    NOT NULL,
  fights      INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (category, fights)
);
