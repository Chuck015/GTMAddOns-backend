-- Fights cut at a conceded Net Launcher net (migration 0022): 1 when the mod ended the fight because a player was netted and did not go for damage.
-- NULL/0 for every other fight.
ALTER TABLE fights ADD COLUMN net_ended INTEGER;
