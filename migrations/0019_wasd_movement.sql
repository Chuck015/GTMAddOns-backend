-- WASD movement data (migration 0019), collected by the mod's MovementInputTracker:
-- fights.movement_input = JSON text of the movement keys during the fight (held milliseconds, direction switches, jumps, distance, top
-- speed); swaps.after_* = the movement keys over the window right after a Wing / Air swap into an empty hotbar slot (held ms of W, A, S, D,
-- the window length in ms, and how often the strafe direction switched).
ALTER TABLE fights ADD COLUMN movement_input TEXT;
ALTER TABLE swaps ADD COLUMN after_w_ms REAL;
ALTER TABLE swaps ADD COLUMN after_a_ms REAL;
ALTER TABLE swaps ADD COLUMN after_s_ms REAL;
ALTER TABLE swaps ADD COLUMN after_d_ms REAL;
ALTER TABLE swaps ADD COLUMN after_window_ms REAL;
ALTER TABLE swaps ADD COLUMN after_strafe_switches REAL;
