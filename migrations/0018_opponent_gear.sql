-- What the opponent looked like in a fight (migration 0018), recorded by the mod's GearTracker:
-- opponent_category = GROUND | WING | JP | AIR from the gear seen on them from 20 s before the fight until it ended
-- (Air = seen with both a jetpack and a wingsuit), opponent_gear = JSON text { start: [6 slots], end: [6 slots], chests: [...] }.
ALTER TABLE fights ADD COLUMN opponent_category TEXT;
ALTER TABLE fights ADD COLUMN opponent_gear TEXT;
