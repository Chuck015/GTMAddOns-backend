-- SwapInfo stats database (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute swapinfo --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS players (
	uuid       TEXT PRIMARY KEY,  -- undashed, lowercase
	name       TEXT NOT NULL,
	first_seen INTEGER NOT NULL,  -- epoch ms
	last_seen  INTEGER NOT NULL,
	mod_version TEXT              -- from the X-GTMAddOns-Version header (migration 0016)
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
CREATE INDEX IF NOT EXISTS fights_category_uuid_ended ON fights (category, uuid, ended_at);

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
	speed_after_bps    REAL,              -- ...and at close (Wing swaps into an empty hotbar slot)
	-- how the inventory opened (migration 0017; see the migration for the meaning)
	cursor_dx          REAL,
	cursor_dy          REAL,
	direct_px          REAL,
	approach_px        REAL,
	gui_x              REAL,
	gui_y              REAL,
	scaled_w           REAL,
	scaled_h           REAL,
	gui_scale          REAL,
	creative           REAL,
	from_screen        REAL
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
CREATE INDEX IF NOT EXISTS fight_guns_fight ON fight_guns (fight_id);

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
CREATE INDEX IF NOT EXISTS fight_combos_fight ON fight_combos (fight_id);
-- Every leaderboard view (category, number of fights, opponent filter) stored as finished JSON,
-- replacing leaderboard_snapshots (no opponent filter only) and the Cloudflare cache, which does
-- nothing on workers.dev. Rows unused for an hour are deleted when a view is stored.
CREATE TABLE IF NOT EXISTS leaderboard_views (
  key         TEXT PRIMARY KEY,
  body        TEXT    NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen);

-- Every login deletes expired sessions and challenges; these keep that cheap (migration 0014).
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
CREATE INDEX IF NOT EXISTS challenges_expires ON challenges (expires);

-- Leaderboard rows per player (migration 0015): each player's entry per category and view size (25 / 50 / 100 fights),
-- rebuilt only when that player's fights in that category changed (leaderboard_dirty).
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
