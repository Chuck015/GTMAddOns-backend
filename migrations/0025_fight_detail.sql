-- One row per fight (migration 0025).
--
-- D1 bills every row written, index entries included, and a fight used to be about 26 of them: its own row plus a row for each swap,
-- each gun and each PvP's combos. Now a fight's swaps, gun totals and combo totals are one JSON text on its own row (fights.detail,
-- see src/detail.ts) and nothing is written to swaps / fight_guns / fight_combos any more. Those three tables are left as they were
-- (no longer read once every fight has its detail) and can be dropped later.
ALTER TABLE fights ADD COLUMN detail TEXT;

-- Every fight stored before this gets its detail from the old tables (the same text the worker writes). On a big table run it in
-- id ranges (add "AND id BETWEEN a AND b"); it is safe to repeat, and the worker does the same for any fight it meets without one.
UPDATE fights SET detail = json_object('v', 1, 's', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(ts, result, category, swap_type, total_ms, reach_ms, slot_to_hotbar_ms, hotbar_to_close_ms, wing_to_hotbar_ms, mouse_deg, approach_deg, needed_deg, efficiency, away_deg, overflick_deg, overflick_peak_deg, after_deg, speed_before_bps, speed_after_bps, cursor_dx, cursor_dy, direct_px, approach_px, gui_x, gui_y, scaled_w, scaled_h, gui_scale, creative, from_screen, after_w_ms, after_a_ms, after_s_ms, after_d_ms, after_window_ms, after_strafe_switches) AS x FROM swaps WHERE swaps.fight_id = fights.id ORDER BY swaps.ts, swaps.id))), 'g', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps, net_shots, net_hits, net_headshots) AS x FROM fight_guns WHERE fight_guns.fight_id = fights.id ORDER BY fight_guns.category, fight_guns.gun))), 'c', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(category, enemy_combos, enemy_broken, own_combos, own_broken, enemy_first_hits, own_first_hits) AS x FROM fight_combos WHERE fight_combos.fight_id = fights.id ORDER BY fight_combos.category)))) WHERE detail IS NULL;

-- Two indexes nothing needs any more (each cost one row written per fight): the per-category one serves "a player's newest fights",
-- and fights_category_opponent serves "all fights of a category".
DROP INDEX IF EXISTS fights_uuid_ended;
DROP INDEX IF EXISTS fights_category_uuid_ended;
