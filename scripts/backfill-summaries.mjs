// Fills in fights.summary (migration 0023) for fights stored before summaries existed, from their swaps, gun totals and combo
// totals, using the same code the worker uses (src/summary.ts; needs node 23.6+ to load TypeScript directly).
//
//   node scripts/backfill-summaries.mjs --remote                (the real database)
//   node scripts/backfill-summaries.mjs --local --persist-to X  (a local copy; any wrangler d1 flags are passed on)
//
// Safe to run again and while the worker is live: it only touches fights whose summary is still NULL.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { METRICS, buildSummary } from "../src/summary.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const flags = process.argv.slice(2);
if (flags.length === 0) {
	console.error("say --remote or --local");
	process.exit(1);
}

/** Runs SQL through wrangler (no shell, so nothing needs quoting) and returns the last statement's rows. */
function sql(command) {
	for (let attempt = 1; ; attempt++) {
		try {
			const out = execFileSync(process.execPath, [wrangler, "d1", "execute", "swapinfo", ...flags, "--json", "--command", command],
				{ cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
			const results = JSON.parse(out.slice(out.indexOf("[")));
			return results[results.length - 1].results ?? [];
		} catch (e) {
			if (attempt >= 4) throw e;
		}
	}
}

const FIGHTS_PER_READ = 400;
/** Windows allows about 32 000 characters on a command line. */
const MAX_COMMAND = 24_000;
const quote = (text) => "'" + text.replace(/'/g, "''") + "'";

let done = 0;
for (;;) {
	const fights = sql(`SELECT id FROM fights WHERE summary IS NULL ORDER BY id LIMIT ${FIGHTS_PER_READ}`);
	if (fights.length === 0) break;
	const ids = fights.map((f) => f.id);
	const range = `fight_id BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}`;
	const swaps = sql(`SELECT fight_id, ts, result, category, swap_type, total_ms, ${METRICS.join(", ")} FROM swaps WHERE ${range}`);
	const guns = sql(`SELECT fight_id, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps, net_shots, net_hits, net_headshots FROM fight_guns WHERE ${range}`);
	const combos = sql(`SELECT fight_id, category, enemy_combos, enemy_broken, own_combos, own_broken, enemy_first_hits, own_first_hits FROM fight_combos WHERE ${range}`);
	const group = (rows) => {
		const map = new Map();
		for (const row of rows) {
			if (!map.has(row.fight_id)) map.set(row.fight_id, []);
			map.get(row.fight_id).push(row);
		}
		return map;
	};
	const swapsOf = group(swaps), gunsOf = group(guns), combosOf = group(combos);

	let command = "";
	const flush = () => {
		if (command) sql(command);
		command = "";
	};
	for (const id of ids) {
		const summary = JSON.stringify(buildSummary(swapsOf.get(id) ?? [], gunsOf.get(id) ?? [], combosOf.get(id) ?? []));
		const statement = `UPDATE fights SET summary = ${quote(summary)} WHERE id = ${id} AND summary IS NULL;`;
		if (command.length + statement.length > MAX_COMMAND) flush();
		command += statement;
	}
	flush();
	done += ids.length;
	console.log(`summarised ${done} fights`);
}
console.log(done === 0 ? "nothing to do" : "done");
