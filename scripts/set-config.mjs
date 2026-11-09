// Checks remote-config.json and stores it as the config the mod fetches from GET /config (table remote_config).
// No deploy needed: mods pick it up within about 30 minutes (5 minutes of caching, then their own 30-minute refresh).
//   node scripts/set-config.mjs            -> the live database
//   node scripts/set-config.mjs --local    -> the local one (wrangler dev)
//   node scripts/set-config.mjs --check    -> only check the file
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Must match the mod's Probes.EVENTS and Rule.parse.
const EVENTS = ["damage", "melee_hit", "melee_hit_me", "combo_msg", "recover_msg", "cooldown", "action_bar", "title", "subtitle", "sound",
	"particle", "click", "shot", "shot_result", "move", "swap",
	"health", "hotbar", "sprint", "velocity", "boost_press", "boost", "jetpack_tap", "jetpack_start", "near", "fight_start", "fight_end"];
const OPS = ["count", "value", "between", "by", "bucket"];
const MAX_RULES = 64, MAX_BYTES = 64 * 1024;

const text = readFileSync(new URL("../remote-config.json", import.meta.url), "utf8");
const config = JSON.parse(text);
const problems = [];
if (!Number.isInteger(config.version)) problems.push("version must be a whole number (raise it on every change)");
const rules = Array.isArray(config.probes) ? config.probes : [];
if (rules.length > MAX_RULES) problems.push(`at most ${MAX_RULES} probes`);
const ids = new Set();
for (const r of rules) {
	const name = r?.id ?? "(no id)";
	if (typeof r?.id !== "string" || !/^[a-z0-9_]{1,32}$/.test(r.id)) problems.push(`${name}: id must be 1-32 of a-z 0-9 _`);
	if (ids.has(r?.id)) problems.push(`${name}: id used twice`);
	ids.add(r?.id);
	if (!OPS.includes(r?.op)) problems.push(`${name}: op must be one of ${OPS.join(", ")}`);
	if (!EVENTS.includes(r?.event)) problems.push(`${name}: unknown event ${r?.event}`);
	if (r?.enabled !== undefined && typeof r.enabled !== "boolean") problems.push(`${name}: enabled must be true or false`);
	if (r?.op === "bucket") {
		const e = r.edges;
		if (!Array.isArray(e) || e.length < 1 || e.length > 10 || e.some((v, i) => typeof v !== "number" || (i > 0 && v <= e[i - 1]))) problems.push(`${name}: bucket needs 1-10 rising edges`);
	}
	if ((r?.op === "value" || r?.op === "by" || r?.op === "bucket") && typeof r.field !== "string") problems.push(`${name}: ${r.op} needs a field`);
	if ((r?.op === "by" || r?.op === "bucket") && r.field === "text") problems.push(`${name}: text can only be filtered on, not counted by`);
	if (r?.op === "between" && !EVENTS.includes(r.end)) problems.push(`${name}: between needs a known end event`);
	for (const key of ["where", "end_where"]) {
		for (const [field, cond] of Object.entries(r?.[key] ?? {})) {
			if (cond && typeof cond === "object" && typeof cond.re === "string") {
				try { new RegExp(cond.re); } catch { problems.push(`${name}: bad regex in ${key}.${field}`); }
			}
		}
	}
}
for (const [name, re] of Object.entries(config.patterns ?? {})) {
	try { new RegExp(re); } catch { problems.push(`pattern ${name}: bad regex`); }
	if (!/\(/.test(re)) problems.push(`pattern ${name}: needs a group for the number`);
}
const body = JSON.stringify(config);
if (body.length > MAX_BYTES) problems.push(`config is ${body.length} bytes, at most ${MAX_BYTES}`);
if (problems.length) {
	console.error("remote-config.json has problems:\n  " + problems.join("\n  "));
	process.exit(1);
}
const on = rules.filter((r) => r.enabled !== false).length;
console.log(`remote-config.json OK: version ${config.version}, ${rules.length} probes (${on} on, ${rules.length - on} off), ${body.length} bytes`);
if (process.argv.includes("--check")) process.exit(0);

const dir = mkdtempSync(join(tmpdir(), "gtm-config-"));
const file = join(dir, "config.sql");
writeFileSync(file, `INSERT INTO remote_config (id, body, updated_at) VALUES (1, '${body.replace(/'/g, "''")}', ${Date.now()})
  ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at;\n`);
try {
	execFileSync("npx", ["wrangler", "d1", "execute", "swapinfo", process.argv.includes("--local") ? "--local" : "--remote", "--file", file],
		{ stdio: "inherit", shell: process.platform === "win32" });
} finally {
	rmSync(dir, { recursive: true, force: true });
}
