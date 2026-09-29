-- Adds PvP categories. Existing swaps and gun stats predate categories and
-- are cleared (players and logins are kept).
DELETE FROM swaps;
ALTER TABLE swaps ADD COLUMN category TEXT;
DROP TABLE IF EXISTS gun_stats;
CREATE TABLE gun_stats (
	uuid      TEXT NOT NULL,
	category  TEXT NOT NULL,
	gun       TEXT NOT NULL,
	shots     INTEGER NOT NULL DEFAULT 0,
	hits      INTEGER NOT NULL DEFAULT 0,
	headshots INTEGER NOT NULL DEFAULT 0,
	kills     INTEGER NOT NULL DEFAULT 0,
	last_used INTEGER NOT NULL,
	PRIMARY KEY (uuid, category, gun)
);
