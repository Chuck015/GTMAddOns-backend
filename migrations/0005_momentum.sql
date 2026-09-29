-- Momentum: horizontal speed (blocks/s) when the inventory opened and when
-- it closed, for successful Wing swaps into an empty hotbar slot. Adds
-- columns only; nothing is deleted.
-- Apply with: npx wrangler d1 execute swapinfo --remote --file=migrations/0005_momentum.sql

ALTER TABLE swaps ADD COLUMN speed_before_bps REAL;
ALTER TABLE swaps ADD COLUMN speed_after_bps REAL;
