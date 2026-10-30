/**
 * Fight detail.
 *
 * D1 bills every row written, index entries included. A fight used to be written as one fights row plus a row for each swap,
 * each gun and each PvP's combos, with their indexes: about 26 rows for an average fight. Now the swaps, gun totals and combo
 * totals are kept as one JSON text on the fight's own row (fights.detail), and nothing else is written for them.
 *
 *   { "v": 1, "s": [[...one swap...], ...], "g": [[...one gun...], ...], "c": [[...one PvP's combos...], ...] }
 *
 * Each inner array holds the values of SWAP_COLS / GUN_COLS / COMBO_COLS, BY POSITION (null = not recorded). Only ever add a
 * column at the end of those lists: older fights then simply have shorter arrays, read as null.
 *
 * Who reads it: the fight log and raw info unpack it here (decodeDetail); the admin flags stay in SQL and read it in place with
 * json_each (swapField / gunField), so the database still does that adding up; a summary (summary.ts) can be rebuilt from it.
 *
 * The old tables (swaps, fight_guns, fight_combos) are no longer written. DETAIL_FROM_TABLES builds the same text from them for a
 * fight stored before this (migration 0025 does it for all of them at once; ensureDetails in index.ts for any it meets later).
 */

import { METRICS } from "./summary";
import type { Row } from "./summary";

// How the inventory opened (see migration 0017). Stored with every swap but not part of METRICS, so the stats views don't read them.
export const INPUT_METRICS = ["cursor_dx", "cursor_dy", "direct_px", "approach_px", "gui_x", "gui_y", "scaled_w", "scaled_h", "gui_scale", "creative", "from_screen"] as const;

// WASD over the window after a Wing / Air swap into an empty hotbar slot (migration 0019).
export const AFTER_METRICS = ["after_w_ms", "after_a_ms", "after_s_ms", "after_d_ms", "after_window_ms", "after_strafe_switches"] as const;

// How the inventory was closed and how much input it saw while open (the mod's SwapInputs; information only). close_how is a word, the rest numbers.
export const HANDLING_METRICS = ["close_key", "keys_n", "hotbar_keys_n", "clicks_n", "scrolls_n", "moves_n", "frames_n"] as const;

// Which inventory slots changed during the swap (text, "slot:before>after;...", "none" if nothing moved) and how many slot-click packets the client sent meanwhile.
export const SLOT_CHANGES_MAX_LEN = 400;

/** One swap's values, in this order. Append only. */
export const SWAP_COLS: readonly string[] = ["ts", "result", "category", "swap_type", "total_ms", ...METRICS, ...INPUT_METRICS, ...AFTER_METRICS, "close_how", ...HANDLING_METRICS, "slot_changes", "click_packets"];
/** One gun's totals in one PvP category, in this order. Append only. */
export const GUN_COLS: readonly string[] = ["category", "gun", "shots", "hits", "headshots", "kills", "speed_shots", "speed_total_bps", "speed_best_bps",
	"net_shots", "net_hits", "net_headshots"];
/** One PvP category's combo totals, in this order. Append only. */
export const COMBO_COLS: readonly string[] = ["category", "enemy_combos", "enemy_broken", "own_combos", "own_broken", "enemy_first_hits", "own_first_hits"];

export interface Detail { swaps: Row[]; guns: Row[]; combos: Row[] }

const pack = (cols: readonly string[], row: Row): unknown[] => cols.map((c) => row[c] ?? null);
const unpack = (cols: readonly string[], values: unknown): Row => {
	const row: Row = {};
	const list = Array.isArray(values) ? values : [];
	cols.forEach((c, i) => (row[c] = list[i] ?? null));
	return row;
};

/**
 * The same gun twice in one upload is added up, as the old table did (ON CONFLICT ... DO UPDATE): counts are summed, a missing
 * net / speed count stays missing unless either row has one, and the best speed is the higher.
 */
export function mergeGuns(guns: Row[]): Row[] {
	const merged = new Map<string, Row>();
	const sum = (a: unknown, b: unknown): number | null => (a == null && b == null ? null : ((a as number) ?? 0) + ((b as number) ?? 0));
	for (const g of guns) {
		const key = String(g.category) + "\u0000" + String(g.gun);
		const have = merged.get(key);
		if (!have) {
			merged.set(key, { ...g });
			continue;
		}
		for (const c of ["shots", "hits", "headshots", "kills"]) have[c] = ((have[c] as number) ?? 0) + ((g[c] as number) ?? 0);
		for (const c of ["net_shots", "net_hits", "net_headshots", "speed_shots", "speed_total_bps"]) have[c] = sum(have[c], g[c]);
		const a = have.speed_best_bps as number | null, b = g.speed_best_bps as number | null;
		have.speed_best_bps = a == null ? (b ?? null) : b == null ? a : Math.max(a, b);
	}
	return [...merged.values()];
}

/** The text kept in fights.detail for these (already checked) swaps, gun totals and combo totals. */
export function encodeDetail(swaps: Row[], guns: Row[], combos: Row[]): string {
	return JSON.stringify({
		v: 1,
		s: swaps.map((s) => pack(SWAP_COLS, s)),
		g: mergeGuns(guns).map((g) => pack(GUN_COLS, g)),
		c: combos.map((c) => pack(COMBO_COLS, c)),
	});
}

/** A fight's swaps, gun totals and combo totals as rows named like the old tables' columns. Nothing recorded (or unreadable) = empty lists. */
export function decodeDetail(text: string | null | undefined): Detail {
	if (!text) return { swaps: [], guns: [], combos: [] };
	try {
		const d = JSON.parse(text) as { s?: unknown[]; g?: unknown[]; c?: unknown[] };
		return {
			swaps: (d.s ?? []).map((v) => unpack(SWAP_COLS, v)),
			guns: (d.g ?? []).map((v) => unpack(GUN_COLS, v)),
			combos: (d.c ?? []).map((v) => unpack(COMBO_COLS, v)),
		};
	} catch {
		return { swaps: [], guns: [], combos: [] };
	}
}

const pathOf = (cols: readonly string[], name: string): string => {
	const at = cols.indexOf(name);
	if (at < 0) throw new Error("no such detail column: " + name);
	return `'$[${at}]'`;
};

/** SQL for one swap column of a `json_each(<fights>.detail, '$.s') AS <alias>` row. */
export function swapField(name: string, alias = "s"): string {
	return `json_extract(${alias}.value, ${pathOf(SWAP_COLS, name)})`;
}

/** SQL for one gun column of a `json_each(<fights>.detail, '$.g') AS <alias>` row. */
export function gunField(name: string, alias = "g"): string {
	return `json_extract(${alias}.value, ${pathOf(GUN_COLS, name)})`;
}

/**
 * SQL expression giving the detail text of the row of `fights` it is evaluated for, built from the old child tables: the same
 * shape encodeDetail writes. (A value that comes out of a subquery is plain text to SQLite, hence the json(...) around each.)
 */
export const DETAIL_FROM_TABLES =
	`json_object('v', 1, ` +
	`'s', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(${SWAP_COLS.join(", ")}) AS x FROM swaps WHERE swaps.fight_id = fights.id ORDER BY swaps.ts, swaps.id))), ` +
	`'g', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(${GUN_COLS.join(", ")}) AS x FROM fight_guns WHERE fight_guns.fight_id = fights.id ORDER BY fight_guns.category, fight_guns.gun))), ` +
	`'c', json((SELECT json_group_array(json(x)) FROM (SELECT json_array(${COMBO_COLS.join(", ")}) AS x FROM fight_combos WHERE fight_combos.fight_id = fights.id ORDER BY fight_combos.category))))`;
