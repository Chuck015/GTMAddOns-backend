-- Shots fired at a player who was caught in a Net Launcher net (migration 0021): per fight and gun, how many shots, hits and headshots
-- came in the 25 ticks after a Net Launcher hit on a wingsuit player. NULL for fights recorded before the mod counted them.
ALTER TABLE fight_guns ADD COLUMN net_shots INTEGER;
ALTER TABLE fight_guns ADD COLUMN net_hits INTEGER;
ALTER TABLE fight_guns ADD COLUMN net_headshots INTEGER;
