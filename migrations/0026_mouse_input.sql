-- How the mouse moved during a fight (migration 0026): the mod's MouseTracker numbers as JSON text, one per fight, shown in Raw info.
-- Information only: nothing rates or flags with it, and no view or summary reads it.
ALTER TABLE fights ADD COLUMN mouse_input TEXT;
