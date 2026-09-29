-- First hits: melee hits that were neither a break (ending the other
-- player's combo) nor a hold (continuing your own). Every combo starts with
-- a break or a first hit, so these are counted per fight like the combos.
-- Null for fights from mod versions that didn't send them. Adds columns
-- only; nothing is deleted.
-- Apply with: npx wrangler d1 execute swapinfo --remote --command "<these statements>"

ALTER TABLE fight_combos ADD COLUMN enemy_first_hits INTEGER;
ALTER TABLE fight_combos ADD COLUMN own_first_hits INTEGER;
