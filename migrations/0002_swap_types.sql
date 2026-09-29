-- Adds the kind of swap (Air PvP has jetpack, wingsuit and jetpack<->wingsuit swaps).
ALTER TABLE swaps ADD COLUMN swap_type TEXT;
