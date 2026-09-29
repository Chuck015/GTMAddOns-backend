-- Which PvP category (GROUND | WING | JP | AIR) each fight was, so stats,
-- ratings and K/D can be shown per category. Existing fights are filled in
-- from their own data: the category most of their swaps and shots were in.
-- Adds a column only; nothing is deleted.
-- Apply with: npx wrangler d1 execute swapinfo --remote --command "<these statements>"

ALTER TABLE fights ADD COLUMN category TEXT;

UPDATE fights SET category = (
	SELECT category FROM (
		SELECT category, COUNT(*) AS n FROM swaps WHERE fight_id = fights.id AND category IS NOT NULL GROUP BY category
		UNION ALL
		SELECT category, SUM(shots) AS n FROM fight_guns WHERE fight_id = fights.id GROUP BY category
	)
	GROUP BY category ORDER BY SUM(n) DESC LIMIT 1
) WHERE category IS NULL;

CREATE INDEX IF NOT EXISTS fights_uuid_category_ended ON fights (uuid, category, ended_at);
