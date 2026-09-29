-- Melee combo totals per player per PvP category.
CREATE TABLE IF NOT EXISTS combo_stats (
	uuid         TEXT NOT NULL,
	category     TEXT NOT NULL,
	enemy_combos INTEGER NOT NULL DEFAULT 0,  -- enemy combos on you
	enemy_broken INTEGER NOT NULL DEFAULT 0,  -- ...that you broke
	own_combos   INTEGER NOT NULL DEFAULT 0,  -- your combos
	own_broken   INTEGER NOT NULL DEFAULT 0,  -- ...that got broken
	last_updated INTEGER NOT NULL,
	PRIMARY KEY (uuid, category)
);
