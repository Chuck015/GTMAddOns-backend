-- Movement guns (Sawed-off Shotgun, Pump Shotgun, Heavy Revolver): your
-- horizontal speed (blocks/s) right after each shot, kept as per-fight
-- totals on the gun's row: how many shots had a speed, their sum and the
-- best. Null for every other gun. Adds columns only; nothing is deleted.
-- Apply with: npx wrangler d1 execute swapinfo --remote --command "<these statements>"

ALTER TABLE fight_guns ADD COLUMN speed_shots INTEGER;
ALTER TABLE fight_guns ADD COLUMN speed_total_bps REAL;
ALTER TABLE fight_guns ADD COLUMN speed_best_bps REAL;
