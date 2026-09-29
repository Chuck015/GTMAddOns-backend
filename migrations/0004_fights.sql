-- Stats are now recorded per fight (combat tag start -> your kill or death),
-- and only each player's last 25 fights are kept. This WIPES all existing
-- swap, gun and combo stats; players and login sessions are kept.
-- Apply with: npx wrangler d1 execute swapinfo --remote --file=migrations/0004_fights.sql

DROP TABLE IF EXISTS swaps;
DROP TABLE IF EXISTS gun_stats;
DROP TABLE IF EXISTS combo_stats;

CREATE TABLE IF NOT EXISTS fights (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid       TEXT NOT NULL,
	fight_key  TEXT NOT NULL,     -- random id from the mod, so a retried upload isn't stored twice
	started_at INTEGER NOT NULL,  -- epoch ms, combat tag start
	ended_at   INTEGER NOT NULL,  -- epoch ms, the kill or death
	outcome    TEXT NOT NULL,     -- KILL | DEATH
	opponent   TEXT,              -- who you killed / who killed you, if the message said
	UNIQUE (uuid, fight_key)
);

CREATE INDEX IF NOT EXISTS fights_uuid_ended ON fights (uuid, ended_at);

CREATE TABLE IF NOT EXISTS swaps (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	fight_id           INTEGER NOT NULL,
	uuid               TEXT NOT NULL,
	ts                 INTEGER NOT NULL,
	result             TEXT NOT NULL,
	category           TEXT,
	swap_type          TEXT,
	total_ms           REAL NOT NULL,
	reach_ms           REAL,
	slot_to_hotbar_ms  REAL,
	hotbar_to_close_ms REAL,
	wing_to_hotbar_ms  REAL,
	mouse_deg          REAL,
	approach_deg       REAL,
	needed_deg         REAL,
	efficiency         REAL,
	away_deg           REAL,
	overflick_deg      REAL,
	overflick_peak_deg REAL,
	after_deg          REAL
);

CREATE INDEX IF NOT EXISTS swaps_uuid_ts ON swaps (uuid, ts);
CREATE INDEX IF NOT EXISTS swaps_fight ON swaps (fight_id);

CREATE TABLE IF NOT EXISTS fight_guns (
	fight_id  INTEGER NOT NULL,
	uuid      TEXT NOT NULL,
	category  TEXT NOT NULL,
	gun       TEXT NOT NULL,
	shots     INTEGER NOT NULL,
	hits      INTEGER NOT NULL,
	headshots INTEGER NOT NULL,
	kills     INTEGER NOT NULL,
	PRIMARY KEY (fight_id, category, gun)
);

CREATE INDEX IF NOT EXISTS fight_guns_uuid ON fight_guns (uuid);

CREATE TABLE IF NOT EXISTS fight_combos (
	fight_id     INTEGER NOT NULL,
	uuid         TEXT NOT NULL,
	category     TEXT NOT NULL,
	enemy_combos INTEGER NOT NULL,
	enemy_broken INTEGER NOT NULL,
	own_combos   INTEGER NOT NULL,
	own_broken   INTEGER NOT NULL,
	PRIMARY KEY (fight_id, category)
);

CREATE INDEX IF NOT EXISTS fight_combos_uuid ON fight_combos (uuid);
