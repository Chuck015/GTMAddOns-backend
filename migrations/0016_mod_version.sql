-- Which mod version a player runs (migration 0016): the mod sends it in X-GTMAddOns-Version with every request; it is kept on the
-- player's row (written only when it changes) so an admin can look it up (GET /admin/player-info).
ALTER TABLE players ADD COLUMN mod_version TEXT;
