-- SwapInfo stats database (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute swapinfo --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS players (
	uuid       TEXT PRIMARY KEY,  -- undashed, lowercase
	name       TEXT NOT NULL,
	first_seen INTEGER NOT NULL,  -- epoch ms
	last_seen  INTEGER NOT NULL
);

-- One-time server IDs handed to the mod for the Mojang session check.
CREATE TABLE IF NOT EXISTS challenges (
	id      TEXT PRIMARY KEY,
	expires INTEGER NOT NULL
);

-- Login sessions. Only a SHA-256 of each token is stored.
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	uuid       TEXT NOT NULL,
	expires    INTEGER NOT NULL
);

-- Stats are recorded per fight (combat tag start -> your kill or death); only
-- each player's last 25 fights are kept (older ones are deleted on upload).
CREATE TABLE IF NOT EXISTS fights (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	uuid       TEXT NOT NULL,
	fight_key  TEXT NOT NULL,     -- random id from the mod, so a retried upload isn't stored twice
	started_at INTEGER NOT NULL,  -- epoch ms, combat tag start
	ended_at   INTEGER NOT NULL,  -- epoch ms, the kill or death
	outcome    TEXT NOT NULL,     -- KILL | DEATH
	opponent   TEXT,              -- who you killed / who killed you, if the message said
	category   TEXT,              -- GROUND | WING | JP | AIR when the fight started
	UNIQUE (uuid, fight_key)
);

CREATE INDEX IF NOT EXISTS fights_uuid_ended ON fights (uuid, ended_at);
CREATE INDEX IF NOT EXISTS fights_uuid_category_ended ON fights (uuid, category, ended_at);

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
	after_deg          REAL,
	speed_before_bps   REAL,              -- momentum: horizontal blocks/s at inventory open...
	speed_after_bps    REAL               -- ...and at close (Wing swaps into an empty hotbar slot)
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
	speed_shots     INTEGER,          -- movement guns only: shots with a speed recorded...
	speed_total_bps REAL,             -- ...their summed horizontal blocks/s right after the shot...
	speed_best_bps  REAL,             -- ...and the fastest
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
	enemy_first_hits INTEGER,  -- hits that were neither a break nor a hold (null: older mod)
	own_first_hits   INTEGER,
	PRIMARY KEY (fight_id, category)
);

CREATE INDEX IF NOT EXISTS fight_combos_uuid ON fight_combos (uuid);
