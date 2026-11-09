-- Tracking that changes without a release (migration 0027).
--
-- remote_config: one row, the JSON the mod fetches from GET /config (switches for its built-in trackers, numbers, message patterns and
-- probe rules; see remote-config.json and scripts/set-config.mjs). Changing it needs no mod update and no deploy.
-- fights.probes: what those rules measured in the fight, flat numbers as JSON text. Information only, shown in Raw info.
ALTER TABLE fights ADD COLUMN probes TEXT;

CREATE TABLE IF NOT EXISTS remote_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
