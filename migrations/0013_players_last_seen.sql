-- Asking who is running the mod looks players up by when they were last seen; without this index that
-- read every player. Index only, no data changes.
CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen);
