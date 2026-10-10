/**
 * Fight summaries.
 *
 * D1 bills by rows read, and one fight is about five rows (the fight, its swaps, its gun totals, its combo totals). Every
 * stats view only needs totals over a player's newest N fights, so each fight's totals are worked out once, when it is
 * uploaded, and kept as a short JSON text on its own row (fights.summary). A view then reads one row per fight and adds
 * the summaries up here, instead of joining the child tables again.
 *
 * The child tables stay complete (the fight log, raw info and the admin flags read them, and a summary can always be
 * rebuilt from them - see summaryFromRows).
 *
 * No imports and no runtime-only syntax in this file: the backfill script runs it under plain node too.
 */

// Optional per-swap numbers; anything missing or non-finite is stored as NULL.
export const METRICS = [
	"reach_ms",
	"slot_to_hotbar_ms",
	"hotbar_to_close_ms",
	"wing_to_hotbar_ms",
	"mouse_deg",
	"approach_deg",
	"needed_deg",
	"efficiency",
	"away_deg",
	"overflick_deg",
	"overflick_peak_deg",
	"after_deg",
	// Momentum: horizontal blocks/s before and after a Wing swap into an empty hotbar slot.
	"speed_before_bps",
	"speed_after_bps",
] as const;

/**
 * The columns a player's page averages over successful swaps. A summary stores one sum and one count per entry, BY POSITION:
 * only ever add to the end of METRICS (a summary written before then simply has no numbers for the new ones).
 */
export const AVG_COLS: readonly string[] = ["total_ms", ...METRICS];
const AT = (name: string) => AVG_COLS.indexOf(name);
const SPEED_BEFORE = AT("speed_before_bps"), SPEED_AFTER = AT("speed_after_bps");

/** Most Wing swaps of one fight kept for the "recent swaps" strip (a page shows 15 in all). */
const RECENT_PER_FIGHT = 15;
export const RECENT_SWAPS = 15;
const GUNS_LISTED = 80;

type Num = number | null;
/** [category, gun, shots, hits, headshots, kills, net_shots, net_hits, net_headshots, speed_shots, speed_total_bps, speed_best_bps] */
type GunSum = [string, string, number, number, number, number, number, number, number, number, number, Num];
/** [category, enemy_combos, enemy_broken, own_combos, own_broken, enemy_first_hits, own_first_hits] */
type ComboSum = [string, number, number, number, number, Num, Num];
/** [ts, result, total_ms, wing_to_hotbar_ms, efficiency, overflick_deg] */
type RecentSwap = [number, string, number, Num, Num, Num];
/** Swaps of one PvP category: counts, the fastest success, and per AVG_COLS entry the sum and count over successes. */
interface SwapSum { n: number; ok: number; f: number; c: number; b: Num; s: number[]; k: number[] }
/** Air swaps of one type: total, successes, cancels, summed time and fastest of the successes, momentum sums and count. */
interface AirSum { n: number; ok: number; c: number; ms: number; b: Num; sb: number; sa: number; mo: number }

export interface Summary {
	v: 1;
	g?: GunSum[];
	/** Wing swaps. */
	w?: SwapSum;
	/** Air swaps: all of them (for the averages), and by type ("" = no type: failed and canceled attempts). */
	a?: SwapSum;
	t?: Record<string, AirSum>;
	c?: ComboSum[];
	r?: RecentSwap[];
}

/** A row as the mod uploads it or as the tables hold it (the column names are the same). */
export type Row = Record<string, unknown>;

const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;
/** Sums are kept to 4 decimals: plenty for averages shown to 2, and it keeps the text short. */
const tidy = (v: number): number => Math.round(v * 10000) / 10000;

function emptySwapSum(): SwapSum {
	return { n: 0, ok: 0, f: 0, c: 0, b: null, s: AVG_COLS.map(() => 0), k: AVG_COLS.map(() => 0) };
}

function addSwap(sum: SwapSum, s: Row): void {
	sum.n++;
	if (s.result === "FAILED") sum.f++;
	else if (s.result === "CANCELED") sum.c++;
	if (s.result !== "SUCCESS") return;
	sum.ok++;
	const total = num(s.total_ms);
	if (total !== null && (sum.b === null || total < sum.b)) sum.b = total;
	AVG_COLS.forEach((col, i) => {
		const v = num(s[col]);
		if (v !== null) {
			sum.s[i] += v;
			sum.k[i]++;
		}
	});
}

/** One fight's totals from its swaps, gun totals and combo totals. */
export function buildSummary(swaps: Row[], guns: Row[], combos: Row[]): Summary {
	const out: Summary = { v: 1 };

	// The same gun twice in one upload is added up, as the table does (ON CONFLICT ... DO UPDATE).
	const gunMap = new Map<string, GunSum>();
	for (const g of guns) {
		const category = String(g.category), gun = String(g.gun);
		const key = category + "\u0000" + gun;
		let sum = gunMap.get(key);
		if (!sum) gunMap.set(key, (sum = [category, gun, 0, 0, 0, 0, 0, 0, 0, 0, 0, null]));
		sum[2] += count(g.shots);
		sum[3] += count(g.hits);
		sum[4] += count(g.headshots);
		sum[5] += count(g.kills);
		sum[6] += count(g.net_shots);
		sum[7] += count(g.net_hits);
		sum[8] += count(g.net_headshots);
		sum[9] += count(g.speed_shots);
		sum[10] = tidy(sum[10] + count(g.speed_total_bps));
		const best = num(g.speed_best_bps);
		if (best !== null && (sum[11] === null || best > sum[11])) sum[11] = best;
	}
	if (gunMap.size > 0) out.g = [...gunMap.values()];

	const wing = emptySwapSum(), air = emptySwapSum();
	const types: Record<string, AirSum> = {};
	const recent: RecentSwap[] = [];
	for (const s of swaps) {
		if (s.category === "WING") {
			addSwap(wing, s);
			recent.push([count(s.ts), String(s.result), count(s.total_ms), num(s.wing_to_hotbar_ms), num(s.efficiency), num(s.overflick_deg)]);
		} else if (s.category === "AIR") {
			addSwap(air, s);
			const type = typeof s.swap_type === "string" ? s.swap_type : "";
			const t = (types[type] ??= { n: 0, ok: 0, c: 0, ms: 0, b: null, sb: 0, sa: 0, mo: 0 });
			t.n++;
			if (s.result === "CANCELED") t.c++;
			if (s.result === "SUCCESS") {
				const total = count(s.total_ms);
				t.ok++;
				t.ms = tidy(t.ms + total);
				if (t.b === null || total < t.b) t.b = total;
				const before = num(s.speed_before_bps), after = num(s.speed_after_bps);
				if (before !== null && after !== null) {
					t.sb = tidy(t.sb + before);
					t.sa = tidy(t.sa + after);
					t.mo++;
				}
			}
		}
	}
	for (const sum of [wing, air]) sum.s = sum.s.map(tidy);
	if (wing.n > 0) out.w = wing;
	if (air.n > 0) {
		out.a = air;
		out.t = types;
	}
	if (recent.length > 0) out.r = recent.sort((x, y) => y[0] - x[0]).slice(0, RECENT_PER_FIGHT);

	if (combos.length > 0) {
		out.c = combos.map((c) => [String(c.category), count(c.enemy_combos), count(c.enemy_broken), count(c.own_combos), count(c.own_broken),
			num(c.enemy_first_hits), num(c.own_first_hits)]);
	}
	return out;
}

// ---- Adding fights up ----

/** A fight as the views read it: its own columns and its summary text (null = not summarised yet, counted as having no children). */
export interface FightRow {
	uuid?: string;
	outcome: string;
	opponent: string | null;
	started_at: number;
	ended_at: number;
	summary: string | null;
	/** The opponent's PvP as the mod worked it out from their gear (null before that was recorded). */
	opponent_category?: string | null;
}

interface GunTotal { category: string; gun: string; shots: number; hits: number; headshots: number; kills: number; net_shots: number; net_hits: number;
	net_headshots: number; speed_shots: number; speed_total: number; speed_best: Num; last_used: number }
interface ComboTotal { category: string; enemy_combos: number; enemy_broken: number; own_combos: number; own_broken: number; enemy_first_hits: number; own_first_hits: number }

/** The totals over a list of fights (a player's newest N). */
export class Totals {
	fights = 0;
	kills = 0;
	deaths = 0;
	private deathMs = 0;
	private wing = emptySwapSum();
	private air = emptySwapSum();
	private types = new Map<string, AirSum>();
	private guns = new Map<string, GunTotal>();
	private combos = new Map<string, ComboTotal>();
	private opponents = new Map<string, { name: string; fights: number }>();
	private recent: RecentSwap[] = [];
	private recentFights: Row[] = [];
	/** Kills and deaths by the opponent's PvP ("" = not known), for the Results rating's opponent adjustment. */
	private byOpponent = new Map<string, { kills: number; deaths: number }>();

	/** Fights must be added newest first (the "recent" lists keep the first ones). */
	add(f: FightRow): void {
		this.fights++;
		if (f.outcome === "KILL") this.kills++;
		if (f.outcome === "DEATH") {
			this.deaths++;
			this.deathMs += f.ended_at - f.started_at;
		}
		const opposing = f.opponent_category ?? "";
		const outcomes = this.byOpponent.get(opposing) ?? { kills: 0, deaths: 0 };
		if (f.outcome === "KILL") outcomes.kills++;
		if (f.outcome === "DEATH") outcomes.deaths++;
		this.byOpponent.set(opposing, outcomes);
		if (this.recentFights.length < 10) {
			this.recentFights.push({ outcome: f.outcome, opponent: f.opponent, started_at: f.started_at, ended_at: f.ended_at });
		}
		if (f.opponent !== null) {
			const key = f.opponent.toLowerCase();
			const seen = this.opponents.get(key);
			if (!seen) this.opponents.set(key, { name: f.opponent, fights: 1 });
			else {
				seen.fights++;
				if (f.opponent > seen.name) seen.name = f.opponent;
			}
		}
		if (!f.summary) return;
		let s: Summary;
		try {
			s = JSON.parse(f.summary) as Summary;
		} catch {
			return;
		}
		for (const g of s.g ?? []) {
			const key = g[0] + "\u0000" + g[1];
			let t = this.guns.get(key);
			if (!t) {
				this.guns.set(key, (t = { category: g[0], gun: g[1], shots: 0, hits: 0, headshots: 0, kills: 0, net_shots: 0, net_hits: 0, net_headshots: 0,
					speed_shots: 0, speed_total: 0, speed_best: null, last_used: f.ended_at }));
			}
			t.shots += g[2];
			t.hits += g[3];
			t.headshots += g[4];
			t.kills += g[5];
			t.net_shots += g[6];
			t.net_hits += g[7];
			t.net_headshots += g[8];
			t.speed_shots += g[9];
			t.speed_total += g[10];
			if (g[11] !== null && g[9] > 0 && (t.speed_best === null || g[11] > t.speed_best)) t.speed_best = g[11];
			if (f.ended_at > t.last_used) t.last_used = f.ended_at;
		}
		if (s.w) mergeSwaps(this.wing, s.w);
		if (s.a) mergeSwaps(this.air, s.a);
		for (const [type, a] of Object.entries(s.t ?? {})) {
			const t = this.types.get(type);
			if (!t) this.types.set(type, { ...a });
			else {
				t.n += a.n;
				t.ok += a.ok;
				t.c += a.c;
				t.ms += a.ms;
				if (a.b !== null && (t.b === null || a.b < t.b)) t.b = a.b;
				t.sb += a.sb;
				t.sa += a.sa;
				t.mo += a.mo;
			}
		}
		for (const c of s.c ?? []) {
			let t = this.combos.get(c[0]);
			if (!t) this.combos.set(c[0], (t = { category: c[0], enemy_combos: 0, enemy_broken: 0, own_combos: 0, own_broken: 0, enemy_first_hits: 0, own_first_hits: 0 }));
			t.enemy_combos += c[1];
			t.enemy_broken += c[2];
			t.own_combos += c[3];
			t.own_broken += c[4];
			t.enemy_first_hits += c[5] ?? 0;
			t.own_first_hits += c[6] ?? 0;
		}
		if (s.r) this.recent.push(...s.r);
	}

	private opponentOutcomes(): Row[] {
		return [...this.byOpponent.entries()].map(([category, o]) => ({ category, kills: o.kills, deaths: o.deaths }));
	}

	private deathAverage(): Num {
		return this.deaths > 0 ? this.deathMs / this.deaths : null;
	}

	private gunRows(only: string | null): Row[] {
		return [...this.guns.values()]
			.filter((g) => only === null || g.category === only)
			.map((g) => ({ category: g.category, gun: g.gun, shots: g.shots, hits: g.hits, headshots: g.headshots, kills: g.kills, last_used: g.last_used,
				net_shots: g.net_shots, net_hits: g.net_hits, net_headshots: g.net_headshots }));
	}

	private movementGuns(): Row[] {
		return [...this.guns.values()]
			.filter((g) => g.category === "GROUND" && g.speed_shots > 0)
			.map((g) => ({ gun: g.gun, shots: g.speed_shots, avg_bps: g.speed_total / g.speed_shots, best_bps: g.speed_best }))
			.sort((x, y) => (y.shots as number) - (x.shots as number));
	}

	private airRows(): Row[] {
		// SQL groups NULL first, then by name.
		return [...this.types.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([type, t]) => ({
			swap_type: type === "" ? null : type,
			total: t.n,
			successes: t.ok,
			cancels: t.c,
			avg_ms: t.ok > 0 ? t.ms / t.ok : null,
			best_ms: t.b,
			speed_before_bps: t.mo > 0 ? t.sb / t.mo : null,
			speed_after_bps: t.mo > 0 ? t.sa / t.mo : null,
			momentum_swaps: t.mo,
		}));
	}

	private comboRows(only: string | null): Row[] {
		return [...this.combos.values()].filter((c) => only === null || c.category === only).map((c) => ({ ...c }));
	}

	/**
	 * This player's leaderboard entry for one PvP category (without name and dates, which are read fresh), carrying only what that
	 * category's ratings use, plus _opp: the opponents in the window as [key, name, fights]. Null with no fights.
	 */
	leaderboardRow(category: string): Row | null {
		if (this.fights === 0) return null;
		const row: Row = {
			fights: this.fights, kills: this.kills, deaths: this.deaths, death_ms: this.deathAverage(), by_opponent: this.opponentOutcomes(),
			total: 0, successes: 0, failures: 0, cancels: 0,
			guns: this.gunRows(category).map(({ last_used, ...rest }) => round2(rest)),
			air_swaps: category === "AIR" ? this.airRows().map(round2) : [],
			combos: category === "JP" || category === "AIR" ? this.comboRows(category).map(round2) : [],
			movement_guns: category === "GROUND" ? this.movementGuns().map(round2) : [],
		};
		if (category === "WING" && this.wing.n > 0) {
			const w = this.wing;
			Object.assign(row, round2({ total: w.n, successes: w.ok, failures: w.f, cancels: w.c, best_ms: w.b }), {
				avg: round2({ total_ms: average(w, 0), speed_before_bps: average(w, SPEED_BEFORE), speed_after_bps: average(w, SPEED_AFTER) }),
			});
		}
		row._opp = [...this.opponents.entries()].map(([key, o]) => [key, o.name, o.fights]);
		return row;
	}

	/** Everything a player's page shows over these fights (see playerDetail). */
	detail(): Row {
		const w = this.wing;
		return {
			fights: this.fights, kills: this.kills, deaths: this.deaths, death_ms: this.deathAverage(), by_opponent: this.opponentOutcomes(),
			total: w.n, successes: w.ok, failures: w.f, cancels: w.c, best_ms: w.b,
			avg: averages(w),
			recent: this.recent.sort((x, y) => y[0] - x[0]).slice(0, RECENT_SWAPS)
				.map((r) => ({ ts: r[0], result: r[1], total_ms: r[2], wing_to_hotbar_ms: r[3], efficiency: r[4], overflick_deg: r[5] })),
			guns: this.gunRows(null).sort((x, y) => (y.shots as number) - (x.shots as number)).slice(0, GUNS_LISTED),
			air_swaps: this.airRows(),
			combos: this.comboRows(null),
			recent_fights: this.recentFights,
			movement_guns: this.movementGuns(),
			air_avg: averages(this.air),
		};
	}
}

function mergeSwaps(into: SwapSum, from: SwapSum): void {
	into.n += from.n;
	into.ok += from.ok;
	into.f += from.f;
	into.c += from.c;
	if (from.b !== null && (into.b === null || from.b < into.b)) into.b = from.b;
	for (let i = 0; i < AVG_COLS.length; i++) {
		into.s[i] += from.s[i] ?? 0;
		into.k[i] += from.k[i] ?? 0;
	}
}

function average(sum: SwapSum, i: number): Num {
	return sum.k[i] > 0 ? sum.s[i] / sum.k[i] : null;
}

function averages(sum: SwapSum): Row {
	const out: Row = {};
	AVG_COLS.forEach((col, i) => (out[col] = average(sum, i)));
	return out;
}

/** Rounds every non-integer number in a row to 2 decimals (times, degrees, speeds). */
export function round2(row: Row): Row {
	const out: Row = {};
	for (const [key, value] of Object.entries(row)) {
		out[key] = typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value;
	}
	return out;
}

/** The totals over the newest n of these fights (already newest first). */
export function totalsOf(fights: FightRow[], n: number): Totals {
	const totals = new Totals();
	for (let i = 0; i < fights.length && i < n; i++) totals.add(fights[i]);
	return totals;
}
