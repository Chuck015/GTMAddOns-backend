-- Admin notices (migration 0024): a message an admin sends to players running the mod, in bulk (everyone on an older version than the
-- newest one in use) or to chosen players. Mods pick pending notices up from their heartbeat (POST /presence) and show them in chat.
CREATE TABLE IF NOT EXISTS admin_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message        TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  created_by     TEXT    NOT NULL,
  all_outdated   INTEGER NOT NULL,  -- 1: every player on a version older than target_version; 0: only the players in notice_targets
  target_version TEXT
);

CREATE TABLE IF NOT EXISTS notice_targets (
  notice_id INTEGER NOT NULL,
  uuid      TEXT    NOT NULL,
  PRIMARY KEY (notice_id, uuid)
);

CREATE TABLE IF NOT EXISTS notice_deliveries (
  notice_id    INTEGER NOT NULL,
  uuid         TEXT    NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, uuid)
);
