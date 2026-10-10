/**
 * SwapInfo stats backend (Cloudflare Worker + D1).
 *
 * Players' mods log in by signing a one-time challenge with their
 * Mojang-issued profile key (the key Minecraft signs chat with), then
 * upload their swaps in batches. Any logged-in player can read everyone's
 * stats.
 *
 * Routes:
 *   POST /auth/challenge        -> { server_id }
 *   POST /auth/login            { username, uuid, server_id, public_key, expires_at,
 *                                 key_signature, signature } -> { token, uuid, name }
 *   GET  /me                    -> { uuid, name, dev }     (logged in)
 *   POST /fights                { fight_key, started_at, ended_at, outcome, opponent, category,
 *                                 swaps: [...], guns: [...], combos: [...] } (logged in)
 *   GET  /players               -> player summaries        (logged in)
 *   POST /admin/notify          { message?, names? } -> sends a notice to players (admin only, see adminNotify)
 *   GET  /players/:uuid/fights?since=ID -> one player's stored fights after fight ID, raw, a page at a time;
 *                               without since: their newest 100 per category (older mods) (logged in)
 *   GET  /players/:uuid?fights=N&category=C -> one player's full stats over their last N
 *                               (25/50/100/250/500) fights of PvP category C, or all fights without it (logged in)
 *
 * Stats are only recorded during fights: from GTM's combat tag starting to
 * the player's kill or death. The mod uploads each finished fight in one
 * go, and only each player's last MAX_FIGHTS (500) fights of each PvP category are
 * kept - older ones are deleted as new ones arrive, so a day of Air fights
 * doesn't push out Wing history. Stats are shown over the last 25, 50, 100,
 * 250 or 500 of those.
 *
 * D1's free plan bills by rows read, so no view walks a whole history or joins
 * the child tables: every fight carries its totals as a summary (summary.ts)
 * and a view reads one row per fight; leaderboards are put together from one
 * stored row per player; and every request's rows are counted (usage.ts).
 *
 * Gun stats come as totals per gun for the fight rather than one row per
 * shot - automatic guns fire many times a second, and per-shot rows would
 * quickly use up D1's daily write allowance.
 *
 * POST /swaps, /guns and /combos are what older mod versions upload to.
 * They answer 200 and store nothing, so those clients drop the data
 * instead of retrying forever.
 */

import { METRICS, Totals, buildSummary, round2, totalsOf } from "./summary";
import type { FightRow, Row } from "./summary";
import { countingDatabase, recordUsage, routeLabel, tightBudget } from "./usage";

export interface Env {
	DB: D1Database;
	DEV_UUIDS: string;
	/** Comma-separated UUIDs allowed to delete players' stats data (the mod's Admin mode). */
	ADMIN_UUIDS: string;
	/** Oldest mod version allowed to upload fights, e.g. "1.1.0". Empty = no minimum. */
	MIN_MOD_VERSION?: string;
	/** Set during a request that met more fights without a summary than it may fill in (healSummaries): its result is not stored as a view. */
	incomplete?: boolean;
}

/** Fights kept per player, per PvP category. */
const MAX_FIGHTS = 500;
/** How many of a player's last fights their page can show (?fights=N). */
const FIGHT_VIEWS = [25, 50, 100, 250, 500];
/** What mods from before the 500-fight history get from the whole-history routes: the newest this many fights per category, as before. */
const LEGACY_FIGHTS = 100;
/** The player list, and a player's page by default, are over this many fights. */
const DEFAULT_VIEW = 25;
const MAX_SWAPS_PER_FIGHT = 300;
const MAX_GUNS_PER_FIGHT = 50;
const MAX_SHOTS_PER_FIGHT = 100_000;
/** Movement gun speeds above this (blocks/s) are dropped as bogus. */
const MAX_SPEED_BPS = 500;
const MAX_FIGHT_MS = 6 * 60 * 60 * 1000;
/** Most old fights deleted by one upload (a player over the limit by more catches up over their next uploads). */
const PRUNE_AT_ONCE = 20;

const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESULTS = new Set(["SUCCESS", "FAILED", "CANCELED"]);
const OUTCOMES = new Set(["KILL", "DEATH"]);
// Kinds of PvP (PvpCategory in the mod). Swap stats are only shown for WING;
// gun stats are kept separately for each.
const CATEGORIES = new Set(["GROUND", "WING", "JP", "AIR"]);
// What a successful swap was. Wing PvP swaps are all WINGSUIT; Air PvP also
// has jetpack swaps and jetpack <-> wingsuit swaps.
const SWAP_TYPES = new Set(["WINGSUIT", "JETPACK", "JP_TO_WING", "WING_TO_JP"]);


// How the inventory opened (see migration 0017). Stored with every swap but not part of METRICS, so the stats views don't read them.
const INPUT_METRICS = ["cursor_dx", "cursor_dy", "direct_px", "approach_px", "gui_x", "gui_y", "scaled_w", "scaled_h", "gui_scale", "creative", "from_screen"] as const;

// WASD over the window after a Wing / Air swap into an empty hotbar slot (migration 0019). Insert only, like INPUT_METRICS.
const AFTER_METRICS = ["after_w_ms", "after_a_ms", "after_s_ms", "after_d_ms", "after_window_ms", "after_strafe_switches"] as const;
// Keys of the fight's movement_input object that are kept (all numbers); anything else the mod sends is dropped.
const MOVEMENT_KEYS = ["ms", "w_ms", "a_ms", "s_ms", "d_ms", "still_ms", "ground_ms", "sprint_ms", "sneak_ms", "strafe_switches", "fb_switches", "jumps", "distance", "max_bps"] as const;

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Every database call is counted (rows read and written), per route and day: see usage.ts.
		const counted = countingDatabase(env.DB);
		try {
			return await route(request, { ...env, DB: counted.db });
		} catch (e) {
			console.error(e);
			return json({ error: "internal error" }, 500);
		} finally {
			ctx.waitUntil(recordUsage(env.DB, routeLabel(request), counted.used));
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	const method = request.method;

	if (method === "POST" && pathname === "/auth/challenge") return createChallenge(env);
	if (method === "POST" && pathname === "/auth/login") return login(request, env);
	if (method === "GET" && pathname === "/me") return me(request, env);
	if (method === "POST" && pathname === "/presence") return presence(request, env);
	if (method === "GET" && pathname === "/users") return modUsers(request, env);
	if (method === "POST" && pathname === "/users/check") return checkModUsers(request, env);
	if (method === "POST" && pathname === "/fights") return uploadFight(request, env);
	if (method === "POST" && (pathname === "/swaps" || pathname === "/guns" || pathname === "/combos")) {
		return ignoreLegacyUpload(request, env);
	}

	const player = pathname.match(/^\/players\/([0-9a-f]{32})$/);
	if (method === "GET" && player) return playerDetail(request, env, player[1]);

	const playerFightList = pathname.match(/^\/players\/([0-9a-f]{32})\/fights$/);
	if (method === "GET" && playerFightList) return playerFights(request, env, playerFightList[1]);
	const playerRawList = pathname.match(/^\/players\/([0-9a-f]{32})\/raw$/);
	if (method === "GET" && playerRawList) return playerRaw(request, env, playerRawList[1]);

	if (method === "GET" && pathname === "/leaderboard") return leaderboard(request, env);

	// Admin mode: looking a player up, and deleting stats data. All check ADMIN_UUIDS on every request.
	if (method === "GET" && pathname === "/admin/player-info") return adminPlayerInfo(request, env);
	if (method === "GET" && pathname === "/admin/flag-rules") return adminFlagRules(request, env);
	if (method === "GET" && pathname === "/admin/flagged") return adminFlagged(request, env);
	if (method === "POST" && pathname === "/admin/notify") return adminNotify(request, env);
	const adminPlayer = pathname.match(/^\/admin\/players\/([0-9a-f]{32})$/);
	if (method === "DELETE" && adminPlayer) return adminDeletePlayerData(request, env, adminPlayer[1]);
	const adminFight = pathname.match(/^\/admin\/players\/([0-9a-f]{32})\/fights\/([0-9a-f]{32})$/);
	if (method === "DELETE" && adminFight) return adminDeleteFight(request, env, adminFight[1], adminFight[2]);

	return json({ error: "not found" }, 404);
}

// ---- Auth ----

async function createChallenge(env: Env): Promise<Response> {
	const now = Date.now();
	const id = randomHex(16);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM challenges WHERE expires < ?").bind(now),
		env.DB.prepare("INSERT INTO challenges (id, expires) VALUES (?, ?)").bind(id, now + CHALLENGE_TTL_MS),
	]);
	return json({ server_id: id });
}

/**
 * Proves account ownership with the player's Mojang-issued profile key -
 * the same key pair Minecraft uses to sign chat messages - instead of
 * calling Mojang's session server, which refuses requests from Cloudflare.
 *
 * Two signatures are checked:
 *   1. key_signature: Mojang's signature binding the player's public key to
 *      their UUID (verified with Mojang's published certificate keys below).
 *   2. signature: the player signing our one-time challenge with the
 *      matching private key, which only their game client has.
 */
async function login(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const username = typeof body?.username === "string" ? body.username : "";
	const serverId = typeof body?.server_id === "string" ? body.server_id : "";
	const uuid = typeof body?.uuid === "string" ? normalizeUuid(body.uuid) : "";
	const expiresAt = finiteOrNull(body?.expires_at);
	const publicKey = base64OrNull(body?.public_key);
	const keySignature = base64OrNull(body?.key_signature);
	const signature = base64OrNull(body?.signature);
	if (
		!/^[A-Za-z0-9_]{1,16}$/.test(username) ||
		!/^[0-9a-f]{32}$/.test(serverId) ||
		!/^[0-9a-f]{32}$/.test(uuid) ||
		expiresAt === null || !publicKey || !keySignature || !signature
	) {
		return json({ error: "bad request" }, 400);
	}

	const now = Date.now();
	const used = await env.DB.prepare("DELETE FROM challenges WHERE id = ? AND expires >= ? RETURNING id")
		.bind(serverId, now)
		.first();
	if (!used) return json({ error: "unknown or expired challenge" }, 401);

	if (expiresAt < now) return json({ error: "profile key expired - restart the game" }, 401);
	if (!(await verifyMojangCertificate(uuid, expiresAt, publicKey, keySignature))) {
		return json({ error: "profile key isn't signed by Mojang for this account (if you just switched accounts, restart the game)" }, 401);
	}
	const playerKey = await crypto.subtle.importKey(
		"spki", publicKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
	);
	const signed = new TextEncoder().encode(loginMessage(serverId, uuid));
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", playerKey, signature, signed))) {
		return json({ error: "challenge signature is invalid" }, 401);
	}
	// The name isn't covered by Mojang's certificate, so it's display-only;
	// stats ownership goes by the UUID, which is verified.
	const profile = { name: username };

	const token = randomHex(32);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now),
		env.DB.prepare(
			`INSERT INTO players (uuid, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
			 ON CONFLICT (uuid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
		).bind(uuid, profile.name, now, now),
		env.DB.prepare("INSERT INTO sessions (token_hash, uuid, expires) VALUES (?, ?, ?)")
			.bind(await sha256Hex(token), uuid, now + SESSION_TTL_MS),
	]);
	// After the player row exists (a first login inserts it just above).
	await modVersionStatement(env, request, uuid)?.run();

	return json({ token, uuid, name: profile.name });
}

/** What the mod signs to log in. Must match StatsClient.loginMessage. */
export function loginMessage(serverId: string, uuid: string): string {
	return `swapinfo-login\n${serverId}\n${uuid}`;
}

// Mojang's player certificate keys ("playerCertificateKeys" at
// https://api.minecraftservices.com/publickeys). Mojang rarely rotates
// these; if logins start failing with "isn't signed by Mojang", refresh them.
const MOJANG_CERTIFICATE_KEYS = [
	"MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAylB4B6m5lz7jwrcFz6Fd/fnfUhcvlxsTSn5kIK/2aGG1C3kMy4VjhwlxF6BFUSnfxhNswPjh3ZitkBxEAFY25uzkJFRwHwVA9mdwjashXILtR6OqdLXXFVyUPIURLOSWqGNBtb08EN5fMnG8iFLgEJIBMxs9BvF3s3/FhuHyPKiVTZmXY0WY4ZyYqvoKR+XjaTRPPvBsDa4WI2u1zxXMeHlodT3lnCzVvyOYBLXL6CJgByuOxccJ8hnXfF9yY4F0aeL080Jz/3+EBNG8RO4ByhtBf4Ny8NQ6stWsjfeUIvH7bU/4zCYcYOq4WrInXHqS8qruDmIl7P5XXGcabuzQstPf/h2CRAUpP/PlHXcMlvewjmGU6MfDK+lifScNYwjPxRo4nKTGFZf/0aqHCh/EAsQyLKrOIYRE0lDG3bzBh8ogIMLAugsAfBb6M3mqCqKaTMAf/VAjh5FFJnjS+7bE+bZEV0qwax1CEoPPJL1fIQjOS8zj086gjpGRCtSy9+bTPTfTR/SJ+VUB5G2IeCItkNHpJX2ygojFZ9n5Fnj7R9ZnOM+L8nyIjPu3aePvtcrXlyLhH/hvOfIOjPxOlqW+O5QwSFP4OEcyLAUgDdUgyW36Z5mB285uKW/ighzZsOTevVUG2QwDItObIV6i8RCxFbN2oDHyPaO5j1tTaBNyVt8CAwEAAQ==",
	"MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAt4t9NPuu7cktclnaH7eZj0omkLcJHeLz5MKsyJEntHZ0INtuBjSSul3Pp3pBeJN8k3ADdcdBLUN90bcAi7WsQqTx3Ft363q3W7TbM8j2iTEdp/0uVspoRt/DP1tkaWFs/w2WwUv9jbVoBUzfUc4pSTIxRwdjmqjZQfvjwKNDbOx3IhP2H0WXodbISejPi1wBZqNW4m1rnZAXp/EpUguxA8mobCa4vUCBkyFDyXdl69/wUSJHyCPmgcMJ364OlAhIqtwVPShBZObvrK/f0BYk6ShJD3N7TFDatSYsIIdcTKRknaIm91s+EsMrdB9U4Yw+ZJ/pyCB4S3vk8zfDCnb0DWIxYH3/EMzaxl77djmTmMzi/JDITup5z3jfWtRZmrAhU2/+W5IO5hEpo3/bCS9PXIY5xb41Lmp2ZO8dXKtyD66Chchy0W129n8vPl2GIruOdrxsjZAHnneyAb9jm0uaGaphwnEnuecX/qgHY6ZMtayvLLsPst8PO6R1vufMy8WqjK+j7LnC1krL7CPDg0NEhyQTmw5l+NCNjSlvB1juM9V4PARg0bYCOkGXm7ydRCjSSH8CJXZpwnd5cBB5WKAX3KPzutRgMi/LFwNSMZzFuUyXaYOZPpD259yqph1LmGqegEdDriACVU+dVEONFMm8eIuBofe7ljmsAFKW9BINwK0CAwEAAQ==",
];

/**
 * Checks Mojang's signature over the player's key certificate, laid out the
 * way Minecraft's PlayerPublicKey.PublicKeyData serializes it: UUID (two
 * big-endian longs), expiry in epoch ms (big-endian long), then the
 * public key's DER encoding. Signed with SHA1withRSA.
 */
export async function verifyMojangCertificate(
	uuid: string, expiresAt: number, publicKey: Uint8Array, keySignature: Uint8Array, keys = MOJANG_CERTIFICATE_KEYS,
): Promise<boolean> {
	const data = new Uint8Array(24 + publicKey.length);
	const view = new DataView(data.buffer);
	view.setBigUint64(0, BigInt("0x" + uuid.slice(0, 16)));
	view.setBigUint64(8, BigInt("0x" + uuid.slice(16)));
	view.setBigInt64(16, BigInt(expiresAt));
	data.set(publicKey, 24);

	for (const encoded of keys) {
		const mojangKey = await crypto.subtle.importKey(
			"spki", base64OrNull(encoded)!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"],
		);
		if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", mojangKey, keySignature, data)) return true;
	}
	return false;
}

/** Returns the logged-in player's UUID, or null if the token is missing/invalid/expired. */
async function authenticate(request: Request, env: Env): Promise<string | null> {
	const header = request.headers.get("Authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!/^[0-9a-f]{64}$/.test(token)) return null;
	const row = await env.DB.prepare("SELECT uuid FROM sessions WHERE token_hash = ? AND expires >= ?")
		.bind(await sha256Hex(token), Date.now())
		.first<{ uuid: string }>();
	return row?.uuid ?? null;
}

/** Dev mode (the mod's detailed gun/event logging) is limited to these accounts. */
function isDev(env: Env, uuid: string): boolean {
	return (env.DEV_UUIDS ?? "")
		.split(",")
		.map((s) => normalizeUuid(s.trim()))
		.includes(uuid);
}

async function me(request: Request, env: Env): Promise<Response> {
	const uuid = await authenticate(request, env);
	if (!uuid) return json({ error: "not logged in" }, 401);
	const player = await env.DB.prepare("SELECT name FROM players WHERE uuid = ?").bind(uuid).first<{ name: string }>();
	return json({ uuid, name: player?.name ?? null, dev: isDev(env, uuid), admin: isAdmin(env, uuid) });
}

// ---- Who is running the mod ----

/** A player counts as running the mod if the backend heard from them (login, upload or heartbeat) this recently. */
const PRESENCE_WINDOW_MS = 40 * 60_000;
/** A heartbeat within this long of the last one is ignored, so nobody can turn it into a write flood. */
const PRESENCE_MIN_GAP_MS = 60_000;

/** The mod sends its version with every request; only a plausible-looking one is kept. */
function modVersionOf(request: Request): string | null {
	const version = request.headers.get("X-GTMAddOns-Version");
	return version !== null && /^[0-9][0-9A-Za-z.+-]{0,23}$/.test(version) ? version : null;
}

/** Records the player's mod version on their row - only when it changed, so it costs no write otherwise. Null if no usable header. */
function modVersionStatement(env: Env, request: Request, uuid: string): D1PreparedStatement | null {
	const version = modVersionOf(request);
	if (version === null) return null;
	return env.DB.prepare("UPDATE players SET mod_version = ? WHERE uuid = ? AND (mod_version IS NULL OR mod_version != ?)").bind(version, uuid, version);
}

/** The mod tells us it is running (about every 15 minutes while the game is open). */
async function presence(request: Request, env: Env): Promise<Response> {
	const uuid = await authenticate(request, env);
	if (!uuid) return json({ error: "not logged in" }, 401);
	const now = Date.now();
	const version = modVersionStatement(env, request, uuid);
	await env.DB.batch([
		env.DB.prepare("UPDATE players SET last_seen = ? WHERE uuid = ? AND last_seen < ?").bind(now, uuid, now - PRESENCE_MIN_GAP_MS),
		...(version ? [version] : []),
	]);
	return json({ ok: true, notices: await pendingNotices(env, uuid, modVersionOf(request), now) });
}

// ---- Admin notices ----

/** The wording of a notice when the admin sends none. The mod's notice screen starts from the same text. */
const DEFAULT_NOTICE = "A new GTMAddOns version is out. Please update: click UPDATE NOW below (or type /gao update), then restart your game once it has downloaded.";
const NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTICE_LENGTH = 240;
const MAX_NOTICE_NAMES = 50;

/** What a notice may contain: one line of plain text (no control characters, no colour codes), cut to MAX_NOTICE_LENGTH. */
export function cleanNotice(text: unknown): string {
	if (typeof text !== "string") return "";
	return text.replace(/[\u0000-\u001f\u007f§]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTICE_LENGTH);
}

/**
 * The notices waiting for this player, at most three, and marks them delivered (each is shown once). A bulk notice (all_outdated)
 * is for a player whose mod version is older than the notice's target_version; any other only for the players it names.
 * Called with every heartbeat, so it is two small-table lookups; an empty list before migration 0024.
 */
async function pendingNotices(env: Env, uuid: string, version: string | null, now: number): Promise<{ id: number; message: string; target_version: string | null }[]> {
	try {
		const { results } = await env.DB.prepare(
			`SELECT n.id, n.message, n.target_version, n.all_outdated FROM admin_notices n
			  WHERE n.expires_at > ?
			    AND NOT EXISTS (SELECT 1 FROM notice_deliveries d WHERE d.notice_id = n.id AND d.uuid = ?)
			    AND (n.all_outdated = 1 OR EXISTS (SELECT 1 FROM notice_targets t WHERE t.notice_id = n.id AND t.uuid = ?))
			  ORDER BY n.id LIMIT 3`,
		).bind(now, uuid, uuid).all<{ id: number; message: string; target_version: string | null; all_outdated: number }>();
		const mine = results.filter((n) => n.all_outdated === 0 || (version !== null && n.target_version !== null && compareVersions(version, n.target_version) < 0));
		if (mine.length === 0) return [];
		const mark = env.DB.prepare("INSERT OR IGNORE INTO notice_deliveries (notice_id, uuid, delivered_at) VALUES (?, ?, ?)");
		await env.DB.batch(mine.map((n) => mark.bind(n.id, uuid, now)));
		return mine.map((n) => ({ id: n.id, message: n.message, target_version: n.all_outdated === 1 ? n.target_version : null }));
	} catch {
		return []; // table not created yet
	}
}

/**
 * Admin mode: send players a notice (the mod shows it in chat with an update button).
 *   POST /admin/notify { message?: string, names?: string[] }
 * With names: only those players (matched ignoring case, at most MAX_NOTICE_NAMES). Without: every player whose mod version is older
 * than the newest version in use. The message defaults to DEFAULT_NOTICE. A notice waits 7 days; each player gets it once, with their
 * next heartbeat (every 15 minutes), and only mods new enough to read notices show it. Answers how many players it is for and how many
 * of them were online (heard from in the last 40 minutes), plus names it could not find.
 */
async function adminNotify(request: Request, env: Env): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;
	const body = await readJson(request);
	const message = cleanNotice(body?.message) || DEFAULT_NOTICE;
	const names = [...new Set((Array.isArray(body?.names) ? body.names : [])
		.filter((n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_]{1,16}$/.test(n))
		.map((n: string) => n.toLowerCase()))].slice(0, MAX_NOTICE_NAMES) as string[];
	const now = Date.now();
	const onlineSince = now - PRESENCE_WINDOW_MS;

	let targets: { uuid: string; name: string }[] = [];
	let unknownNames: string[] = [];
	let targeted = 0, online = 0;
	let targetVersion: string | null = null;
	if (names.length > 0) {
		const { results } = await env.DB.prepare(`SELECT uuid, name, last_seen FROM players WHERE lower(name) IN (${names.map(() => "?").join(", ")})`)
			.bind(...names).all<{ uuid: string; name: string; last_seen: number }>();
		targets = results;
		const found = new Set(results.map((r) => r.name.toLowerCase()));
		unknownNames = names.filter((n) => !found.has(n));
		if (targets.length === 0) return json({ error: "none of those players have used the stats server", unknown_names: unknownNames }, 404);
		targeted = results.length;
		online = results.filter((r) => r.last_seen >= onlineSince).length;
	} else {
		const { results } = await env.DB.prepare("SELECT mod_version, COUNT(*) AS n, COALESCE(SUM(last_seen >= ?), 0) AS online FROM players WHERE mod_version IS NOT NULL GROUP BY mod_version")
			.bind(onlineSince).all<{ mod_version: string; n: number; online: number }>();
		if (results.length === 0) return json({ error: "no mod versions are known yet" }, 400);
		targetVersion = results.map((r) => r.mod_version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
		for (const r of results) {
			if (compareVersions(r.mod_version, targetVersion) < 0) {
				targeted += r.n;
				online += r.online;
			}
		}
	}

	// Expired notices go; then this one.
	await env.DB.batch([
		env.DB.prepare("DELETE FROM notice_targets WHERE notice_id IN (SELECT id FROM admin_notices WHERE expires_at <= ?)").bind(now),
		env.DB.prepare("DELETE FROM notice_deliveries WHERE notice_id IN (SELECT id FROM admin_notices WHERE expires_at <= ?)").bind(now),
		env.DB.prepare("DELETE FROM admin_notices WHERE expires_at <= ?").bind(now),
	]);
	const created = await env.DB.prepare(
		"INSERT INTO admin_notices (message, created_at, expires_at, created_by, all_outdated, target_version) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
	).bind(message, now, now + NOTICE_TTL_MS, auth.admin, targets.length > 0 ? 0 : 1, targetVersion).first<{ id: number }>();
	const id = created?.id ?? 0;
	if (targets.length > 0) {
		const add = env.DB.prepare("INSERT OR IGNORE INTO notice_targets (notice_id, uuid) VALUES (?, ?)");
		await env.DB.batch(targets.map((t) => add.bind(id, t.uuid)));
	}
	console.log(JSON.stringify({ event: "admin_notify", admin: auth.admin, id, mode: targets.length > 0 ? "players" : "outdated", targeted, online, message }));
	return json({ id, mode: targets.length > 0 ? "players" : "outdated", targeted, online, target_version: targetVersion, unknown_names: unknownNames });
}

/**
 * How recently the backend must have heard from a player (login, upload or heartbeat) for a check to say they run the mod. Long on
 * purpose: the mod only asks about players who are on the server right now, so a long-AFK player still counts, and the only false
 * positive is someone who switched to a client without the mod within these hours.
 */
const CHECK_WINDOW_MS = 6 * 60 * 60_000;
const CHECK_MAX_UUIDS = 90;

/**
 * The mod asks once about each player in its tab list: body { uuids: [undashed, ...] } (at most 90), answer { uuids: [the ones
 * running the mod] }. One indexed lookup per uuid, nothing stored.
 */
async function checkModUsers(request: Request, env: Env): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "bad json" }, 400);
	}
	const raw = (body as { uuids?: unknown } | null)?.uuids;
	if (!Array.isArray(raw)) return json({ error: "uuids must be a list" }, 400);
	const uuids = [...new Set(raw.filter((u): u is string => typeof u === "string" && /^[0-9a-f]{32}$/.test(u)))].slice(0, CHECK_MAX_UUIDS);
	if (uuids.length === 0) return json({ uuids: [] });
	const { results } = await env.DB.prepare(
		`SELECT uuid FROM players WHERE last_seen >= ? AND uuid IN (${uuids.map(() => "?").join(", ")})`,
	).bind(Date.now() - CHECK_WINDOW_MS, ...uuids).all<{ uuid: string }>();
	return json({ uuids: results.map((r) => r.uuid) });
}

/**
 * The UUIDs (undashed) of players running the mod right now, for the icon next to their name. Built from
 * players.last_seen (indexed, migration 0013) and stored for five minutes like a leaderboard view, so asking
 * costs one row read.
 */
async function modUsers(request: Request, env: Env): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	const headers = { "Content-Type": "application/json" };
	const stored = await readStoredView(env, "mod-users");
	if (stored) return new Response(stored, { headers });
	const { results } = await env.DB.prepare("SELECT uuid FROM players WHERE last_seen >= ?")
		.bind(Date.now() - PRESENCE_WINDOW_MS)
		.all<{ uuid: string }>();
	const body = JSON.stringify({ uuids: results.map((r) => r.uuid) });
	await storeView(env, "mod-users", body);
	return new Response(body, { headers });
}

/** Admin mode (deleting players' stats data) is limited to these accounts. Checked again on every admin request. */
function isAdmin(env: Env, uuid: string): boolean {
	return (env.ADMIN_UUIDS ?? "")
		.split(",")
		.map((s) => normalizeUuid(s.trim()))
		.filter((s) => s.length > 0)
		.includes(uuid);
}

// ---- Uploads ----

/** Older mod versions still send these; accept and drop, so they don't retry forever. */
async function ignoreLegacyUpload(request: Request, env: Env): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	return json({ stored: 0, note: "stats are recorded per fight now - update the mod" });
}

/**
 * One finished fight: its swaps, gun totals and combo totals, stored in a
 * single transaction. Then anything older than the player's last
 * MAX_FIGHTS fights of that category is deleted. fight_key makes a retried upload a no-op.
 */
async function uploadFight(request: Request, env: Env): Promise<Response> {
	// Before logging in, so refusing an old mod costs no database reads.
	const outdated = refuseOutdatedMod(request, env);
	if (outdated) return outdated;
	const uuid = await authenticate(request, env);
	if (!uuid) return json({ error: "not logged in" }, 401);

	const body = await readJson(request);
	const fightKey = typeof body?.fight_key === "string" ? body.fight_key : "";
	const outcome = typeof body?.outcome === "string" && OUTCOMES.has(body.outcome) ? body.outcome : null;
	const opponentRaw = typeof body?.opponent === "string" ? body.opponent.trim() : "";
	const opponent = /^[A-Za-z0-9_]{1,16}$/.test(opponentRaw) ? opponentRaw : null;
	const swaps: unknown[] = Array.isArray(body?.swaps) ? body.swaps : [];
	const guns: unknown[] = Array.isArray(body?.guns) ? body.guns : [];
	const combos: unknown[] = Array.isArray(body?.combos) ? body.combos : [];
	const now = Date.now();
	const endedAt = clampTs(finiteOrNull(body?.ended_at) ?? now, now);
	const startedAt = Math.min(endedAt, Math.max(endedAt - MAX_FIGHT_MS, Math.round(finiteOrNull(body?.started_at) ?? endedAt)));
	if (
		!/^[0-9a-f]{32}$/.test(fightKey) || outcome === null ||
		swaps.length > MAX_SWAPS_PER_FIGHT || guns.length > MAX_GUNS_PER_FIGHT || combos.length > CATEGORIES.size
	) {
		return json({ error: "bad request" }, 400);
	}

	const category = typeof body?.category === "string" && CATEGORIES.has(body.category)
		? body.category
		: guessCategory(swaps, guns);

	// Is it already stored, and how many fights of this category does the player have (fight_counts, so nothing is counted here)?
	const [existing, counted] = await env.DB.batch<{ id?: number; fights?: number }>([
		env.DB.prepare("SELECT id FROM fights WHERE uuid = ? AND fight_key = ?").bind(uuid, fightKey),
		env.DB.prepare("SELECT fights FROM fight_counts WHERE uuid = ? AND category = ?").bind(uuid, category ?? ""),
	]);
	if (existing.results.length > 0) return json({ stored: 0, duplicate: true });
	const storedFights = counted.results[0]?.fights ?? 0;

	// What the opponent looked like (the mod's GearTracker): a PvP category and a short JSON text of their gear.
	const opponentCategory = typeof body?.opponent_category === "string" && CATEGORIES.has(body.opponent_category) ? body.opponent_category : null;
	const opponentGear = typeof body?.opponent_gear === "string" && body.opponent_gear.length > 0 && body.opponent_gear.length <= 1600 ? body.opponent_gear : null;

	// The opponent's timeline (the mod's GearTracker): short JSON text.
	const opponentTrack = typeof body?.opponent_track === "string" && body.opponent_track.length > 0 && body.opponent_track.length <= 2000 ? body.opponent_track : null;

	// 1 when the mod cut this fight at a conceded net (see the mod's NetFightEnd).
	const netEnded = body?.net_ended === true ? 1 : null;

	// The movement keys during the fight, kept as JSON text of the known numbers only.
	let movementInput: string | null = null;
	if (body?.movement_input && typeof body.movement_input === "object") {
		const kept: Record<string, number> = {};
		for (const key of MOVEMENT_KEYS) {
			const v = finiteOrNull((body.movement_input as Record<string, unknown>)[key]);
			if (v !== null) kept[key] = Math.round(v * 100) / 100;
		}
		if (Object.keys(kept).length > 0) movementInput = JSON.stringify(kept);
	}

	// Children find their fight by (uuid, fight_key), so everything can go in one batch.
	const fightId = "(SELECT id FROM fights WHERE uuid = ? AND fight_key = ?)";
	// The fight's own row goes in first, but its summary needs the checked children: it is put in front once they are known.
	const statements: D1PreparedStatement[] = [];
	const swapRows: Row[] = [], gunRows: Row[] = [], comboRows: Row[] = [];

	const swapColumns = ["uuid", "ts", "result", "category", "swap_type", "total_ms", ...METRICS, ...INPUT_METRICS, ...AFTER_METRICS];
	const insertSwap = env.DB.prepare(
		`INSERT INTO swaps (fight_id, ${swapColumns.join(", ")}) VALUES (${fightId}, ${swapColumns.map(() => "?").join(", ")})`,
	);
	for (const raw of swaps) {
		const s = (raw ?? {}) as Record<string, unknown>;
		const totalMs = finiteOrNull(s.total_ms);
		const validCategory = typeof s.category === "string" && CATEGORIES.has(s.category);
		const swapType = s.swap_type ?? null;
		const validType = swapType === null || (typeof swapType === "string" && SWAP_TYPES.has(swapType));
		if (typeof s.result !== "string" || !RESULTS.has(s.result) || totalMs === null || !validCategory || !validType) {
			return json({ error: "bad swap record" }, 400);
		}
		const ts = clampTs(finiteOrNull(s.ts) ?? now, now);
		const metrics = METRICS.map((m) => finiteOrNull(s[m]));
		statements.push(insertSwap.bind(uuid, fightKey, uuid, ts, s.result, s.category, swapType, totalMs,
			...metrics, ...INPUT_METRICS.map((m) => finiteOrNull(s[m])), ...AFTER_METRICS.map((m) => finiteOrNull(s[m]))));
		const kept: Row = { ts, result: s.result, category: s.category, swap_type: swapType, total_ms: totalMs };
		METRICS.forEach((m, i) => (kept[m] = metrics[i]));
		swapRows.push(kept);
	}

	const insertGun = env.DB.prepare(
		`INSERT INTO fight_guns (fight_id, uuid, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps, net_shots, net_hits, net_headshots)
		 VALUES (${fightId}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (fight_id, category, gun) DO UPDATE SET
		   shots = shots + excluded.shots, hits = hits + excluded.hits,
		   headshots = headshots + excluded.headshots, kills = kills + excluded.kills,
		   net_shots = CASE WHEN excluded.net_shots IS NULL THEN net_shots ELSE COALESCE(net_shots, 0) + excluded.net_shots END,
		   net_hits = CASE WHEN excluded.net_hits IS NULL THEN net_hits ELSE COALESCE(net_hits, 0) + excluded.net_hits END,
		   net_headshots = CASE WHEN excluded.net_headshots IS NULL THEN net_headshots ELSE COALESCE(net_headshots, 0) + excluded.net_headshots END,
		   speed_shots = CASE WHEN excluded.speed_shots IS NULL THEN speed_shots ELSE COALESCE(speed_shots, 0) + excluded.speed_shots END,
		   speed_total_bps = CASE WHEN excluded.speed_total_bps IS NULL THEN speed_total_bps ELSE COALESCE(speed_total_bps, 0) + excluded.speed_total_bps END,
		   speed_best_bps = MAX(COALESCE(speed_best_bps, excluded.speed_best_bps), COALESCE(excluded.speed_best_bps, speed_best_bps))`,
	);
	for (const raw of guns) {
		const g = (raw ?? {}) as Record<string, unknown>;
		const gun = typeof g.gun === "string" ? g.gun.trim() : "";
		const category = typeof g.category === "string" && CATEGORIES.has(g.category) ? g.category : null;
		const [shots, hits, headshots, kills] = [g.shots, g.hits, g.headshots, g.kills].map(countOrNull);
		const valid = category !== null && gun.length > 0 && gun.length <= 48 &&
			shots !== null && hits !== null && headshots !== null && kills !== null &&
			shots <= MAX_SHOTS_PER_FIGHT && hits <= shots && headshots <= hits && kills <= shots;
		if (!valid) return json({ error: "bad gun record" }, 400);
		// Movement guns also send the speed right after their shots; all three or none.
		// Bad speed values are dropped rather than rejecting the whole fight.
		const speedShots = countOrNull(g.speed_shots);
		const speedTotal = finiteOrNull(g.speed_total_bps);
		const speedBest = finiteOrNull(g.speed_best_bps);
		const hasSpeed = speedShots !== null && speedShots > 0 && speedShots <= shots &&
			speedTotal !== null && speedBest !== null && speedBest >= 0 && speedBest <= MAX_SPEED_BPS &&
			speedTotal >= 0 && speedTotal <= speedBest * speedShots + 0.001;
		// Shots at a netted player (Net Launcher): all three or none, consistent with the totals; bad values are dropped, not the fight.
		const [netShots, netHits, netHeadshots] = [g.net_shots, g.net_hits, g.net_headshots].map(countOrNull);
		const hasNet = netShots !== null && netHits !== null && netHeadshots !== null && netShots <= shots && netHits <= netShots && netHits <= hits && netHeadshots <= netHits && netHeadshots <= headshots;
		statements.push(insertGun.bind(uuid, fightKey, uuid, category, gun, shots, hits, headshots, kills,
			hasSpeed ? speedShots : null, hasSpeed ? speedTotal : null, hasSpeed ? speedBest : null,
			hasNet ? netShots : null, hasNet ? netHits : null, hasNet ? netHeadshots : null));
		gunRows.push({ category, gun, shots, hits, headshots, kills,
			speed_shots: hasSpeed ? speedShots : null, speed_total_bps: hasSpeed ? speedTotal : null, speed_best_bps: hasSpeed ? speedBest : null,
			net_shots: hasNet ? netShots : null, net_hits: hasNet ? netHits : null, net_headshots: hasNet ? netHeadshots : null });
	}

	const insertCombo = env.DB.prepare(
		`INSERT INTO fight_combos (fight_id, uuid, category, enemy_combos, enemy_broken, own_combos, own_broken,
		                          enemy_first_hits, own_first_hits)
		 VALUES (${fightId}, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const comboCategories = new Set<string>();
	for (const raw of combos) {
		const c = (raw ?? {}) as Record<string, unknown>;
		const category = typeof c.category === "string" && CATEGORIES.has(c.category) ? c.category : null;
		const [enemy, enemyBroken, own, ownBroken] = [c.enemy_combos, c.enemy_broken, c.own_combos, c.own_broken].map(countOrNull);
		const valid = category !== null && !comboCategories.has(category) &&
			enemy !== null && enemyBroken !== null && own !== null && ownBroken !== null &&
			enemy <= MAX_SHOTS_PER_FIGHT && own <= MAX_SHOTS_PER_FIGHT && enemyBroken <= enemy && ownBroken <= own;
		if (!valid) return json({ error: "bad combo record" }, 400);
		comboCategories.add(category);
		// First hits start combos, so there can't be more than combos. Older mod
		// versions don't send them (null); bad values are dropped, not rejected.
		const enemyFirst = countOrNull(c.enemy_first_hits);
		const ownFirst = countOrNull(c.own_first_hits);
		const firstEnemy = enemyFirst !== null && enemyFirst <= enemy ? enemyFirst : null;
		const firstOwn = ownFirst !== null && ownFirst <= own ? ownFirst : null;
		statements.push(insertCombo.bind(uuid, fightKey, uuid, category, enemy, enemyBroken, own, ownBroken, firstEnemy, firstOwn));
		comboRows.push({ category, enemy_combos: enemy, enemy_broken: enemyBroken, own_combos: own, own_broken: ownBroken,
			enemy_first_hits: firstEnemy, own_first_hits: firstOwn });
	}

	// The fight itself, with its totals as a summary (see summary.ts): every stats view reads that one row instead of the children.
	statements.unshift(
		env.DB.prepare(
			"INSERT INTO fights (uuid, fight_key, started_at, ended_at, outcome, opponent, category, opponent_category, opponent_gear, movement_input, opponent_track, net_ended, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(uuid, fightKey, startedAt, endedAt, outcome, opponent, category, opponentCategory, opponentGear, movementInput, opponentTrack, netEnded,
			JSON.stringify(buildSummary(swapRows, gunRows, comboRows))),
	);

	// Keep only the newest MAX_FIGHTS fights of this category (children first, then the fights). The player's count is kept in
	// fight_counts, so nothing is looked at until they are over the limit, and then only the oldest few (by index).
	if (category) {
		const excess = Math.min(PRUNE_AT_ONCE, storedFights + 1 - MAX_FIGHTS);
		if (excess > 0) {
			const old = `SELECT id FROM fights WHERE uuid = ? AND category = ? ORDER BY ended_at, id LIMIT ${excess}`;
			for (const table of ["swaps", "fight_guns", "fight_combos"]) {
				statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE fight_id IN (${old})`).bind(uuid, category));
			}
			statements.push(env.DB.prepare(`DELETE FROM fights WHERE id IN (${old})`).bind(uuid, category));
		}
		statements.push(env.DB.prepare(
			"INSERT INTO fight_counts (uuid, category, fights) VALUES (?, ?, 1) ON CONFLICT (uuid, category) DO UPDATE SET fights = fights + 1 - ?",
		).bind(uuid, category, Math.max(0, excess)));
	}
	statements.push(env.DB.prepare("UPDATE players SET last_seen = ? WHERE uuid = ?").bind(now, uuid));
	if (category) statements.push(dirtyStatement(env, uuid, category));
	const version = modVersionStatement(env, request, uuid);
	if (version) statements.push(version);
	await env.DB.batch(statements);

	return json({ stored: 1 });
}

/**
 * Mods older than MIN_MOD_VERSION may not upload. Versions from before the updater send no
 * version header: they get 400, which makes them drop the fight instead of retrying forever.
 * Newer ones get 426, keep their fights and update themselves (see the mod's Updater).
 */
function refuseOutdatedMod(request: Request, env: Env): Response | null {
	const min = (env.MIN_MOD_VERSION ?? "").trim();
	if (!min) return null;
	const version = request.headers.get("X-GTMAddOns-Version");
	if (version === null) return json({ error: "this GTMAddOns version is too old - update the mod" }, 400);
	if (compareVersions(version, min) < 0) return json({ error: "update required", min_version: min }, 426);
	return null;
}

/** Compares dotted version numbers: "1.10.0" > "1.9.2". */
export function compareVersions(a: string, b: string): number {
	const x = a.split(/[^0-9]+/), y = b.split(/[^0-9]+/);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const p = Number(x[i] || 0), q = Number(y[i] || 0);
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/**
 * A fight's category when the mod didn't send one (older versions): the
 * one most of its swaps and shots were in, or null if it has neither.
 */
function guessCategory(swaps: unknown[], guns: unknown[]): string | null {
	const counts = new Map<string, number>();
	const add = (category: unknown, n: number) => {
		if (typeof category === "string" && CATEGORIES.has(category) && n > 0) counts.set(category, (counts.get(category) ?? 0) + n);
	};
	for (const s of swaps) add((s as Record<string, unknown>)?.category, 1);
	for (const g of guns) add((g as Record<string, unknown>)?.category, countOrNull((g as Record<string, unknown>)?.shots) ?? 0);
	let best: string | null = null;
	for (const [category, n] of counts) if (best === null || n > counts.get(best)!) best = category;
	return best;
}

/** Timestamps from the mod, kept between a week ago and now. */
function clampTs(ts: number, now: number): number {
	return Math.min(now, Math.max(now - MAX_TS_AGE_MS, Math.round(ts)));
}

// ---- Viewing stats ----
// Each player's last MAX_FIGHTS fights of each category are stored. A player's page asks for
// their last 25, 50, 100, 250 or 500 fights of one PvP category
// (?fights=N&category=JP), so each tab is over that kind of fight.

/** A fight as the stats views read it: one row, with its totals in summary (see summary.ts). */
type StoredFight = FightRow & { id: number };
const FIGHT_COLUMNS = "id, uuid, outcome, opponent, started_at, ended_at, summary, opponent_category";

/**
 * A player's newest n fights (of one category, if given), newest first. Reads n rows, by index, however long their history is.
 * category must already be checked against CATEGORIES - it's written into the SQL.
 */
function newestFights(env: Env, uuid: string, n: number, category: string | null): D1PreparedStatement {
	const only = category !== null && CATEGORIES.has(category) ? ` AND category = '${category}'` : "";
	return env.DB.prepare(`SELECT ${FIGHT_COLUMNS} FROM fights WHERE uuid = ?${only} ORDER BY ended_at DESC, id DESC LIMIT ${n}`).bind(uuid);
}

/** Fights summarised per database call, and per request, when some have no summary yet. */
const HEAL_CHUNK = 60;
const HEAL_MAX = 240;

/**
 * Fights stored before summaries existed (or by a worker version from before them) have none: work it out from their swaps, gun
 * totals and combo totals, keep it, and fill it in on the rows given. At most HEAL_MAX per request; any left count as fights
 * without swaps or shots in this answer (marked incomplete, so it is not kept as a view) and are reached by later requests.
 */
async function healSummaries(env: Env, fights: StoredFight[]): Promise<void> {
	const all = fights.filter((f) => f.summary === null);
	if (all.length > HEAL_MAX) env.incomplete = true;
	const missing = all.slice(0, HEAL_MAX);
	for (let at = 0; at < missing.length; at += HEAL_CHUNK) {
		const part = missing.slice(at, at + HEAL_CHUNK);
		// Ids straight from the database, so they are safe to write into the SQL.
		const ids = part.map((f) => Math.trunc(f.id)).join(", ");
		const [swaps, guns, combos] = await env.DB.batch<Row>([
			env.DB.prepare(`SELECT fight_id, ts, result, category, swap_type, total_ms, ${METRICS.join(", ")} FROM swaps WHERE fight_id IN (${ids})`),
			env.DB.prepare(
				`SELECT fight_id, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps, net_shots, net_hits, net_headshots
				   FROM fight_guns WHERE fight_id IN (${ids})`,
			),
			env.DB.prepare(
				`SELECT fight_id, category, enemy_combos, enemy_broken, own_combos, own_broken, enemy_first_hits, own_first_hits
				   FROM fight_combos WHERE fight_id IN (${ids})`,
			),
		]);
		const of = (rows: Row[], id: number) => rows.filter((r) => r.fight_id === id);
		const update = env.DB.prepare("UPDATE fights SET summary = ? WHERE id = ? AND summary IS NULL");
		await env.DB.batch(part.map((f) => {
			f.summary = JSON.stringify(buildSummary(of(swaps.results, f.id), of(guns.results, f.id), of(combos.results, f.id)));
			return update.bind(f.summary, f.id);
		}));
	}
}

/**
 * One player's stats over their newest N fights (of one PvP category, or of all without it): one row read per fight, added up
 * from the fights' summaries.
 */
async function playerDetail(request: Request, env: Env, uuid: string): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	const player = await env.DB.prepare("SELECT uuid, name, first_seen, last_seen FROM players WHERE uuid = ?")
		.bind(uuid)
		.first();
	if (!player) return json({ error: "no such player" }, 404);

	const params = new URL(request.url).searchParams;
	const asked = Number(params.get("fights"));
	const n = FIGHT_VIEWS.includes(asked) ? asked : DEFAULT_VIEW;
	const askedCategory = params.get("category");
	const category = askedCategory !== null && CATEGORIES.has(askedCategory) ? askedCategory : null;

	const fights = (await newestFights(env, uuid, n, category).all<StoredFight>()).results;
	await healSummaries(env, fights);
	return json({ ...player, ...totalsOf(fights, n).detail() });
}

/** How long a player's raw data is kept before it is read again, and the most swap rows it holds. */
const RAW_TTL_S = 900;
const RAW_MAX_SWAPS = 4000;
/** Columns that are the same on every row or only link rows together, so they are not sent. */
const RAW_SKIP = new Set(["id", "uuid", "fight_id", "summary"]);

/**
 * What the backend stores about one player, as it is stored: the player row and, for their newest LEGACY_FIGHTS fights of each
 * category (a whole 500-fight history would not fit one reply), the fights, their swaps, gun totals and combo totals (SELECT *, so a column added later is included automatically).
 * Open to every logged-in player - it is the same data the stats screens are built from, and what the admin flags are computed from.
 * Sent column-wise to keep it small: { player, fights: { cols, rows }, swaps: { cols, rows, fight }, ... } where each row is an array of
 * values in cols order (null = not recorded), numbers rounded to 2 decimals, and "fight" gives each child row its fight's row number.
 * Kept in leaderboard_views for RAW_TTL_S, so opening it again costs one row; cut to RAW_MAX_SWAPS swaps (newest first).
 */
async function playerRaw(request: Request, env: Env, uuid: string): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	const headers = { "Content-Type": "application/json" };
	const key = `raw-${uuid}`;
	const stored = await readStoredView(env, key, tightBudget() ? TIGHT_TTL_S : RAW_TTL_S);
	if (stored) return new Response(stored, { headers });

	const player = await env.DB.prepare("SELECT uuid, name, first_seen, last_seen, mod_version FROM players WHERE uuid = ?").bind(uuid).first();
	if (!player) return json({ error: "no such player" }, 404);
	const kept = newestPerCategory(LEGACY_FIGHTS);
	const uuids = Array<string>(PER_CATEGORY_BINDS).fill(uuid);
	const [fights, swaps, guns, combos] = await env.DB.batch([
		env.DB.prepare(`SELECT * FROM fights WHERE id IN (${kept}) ORDER BY ended_at DESC, id DESC`).bind(...uuids),
		env.DB.prepare(`SELECT * FROM swaps WHERE fight_id IN (${kept}) ORDER BY ts DESC LIMIT ${RAW_MAX_SWAPS}`).bind(...uuids),
		env.DB.prepare(`SELECT * FROM fight_guns WHERE fight_id IN (${kept})`).bind(...uuids),
		env.DB.prepare(`SELECT * FROM fight_combos WHERE fight_id IN (${kept})`).bind(...uuids),
	]);

	const fightRows = fights.results as Record<string, unknown>[];
	const rowOfFight = new Map<number, number>();
	fightRows.forEach((f, i) => rowOfFight.set(f.id as number, i));
	const round = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
	const table = (rows: Record<string, unknown>[], children: boolean) => {
		const cols = rows.length > 0 ? Object.keys(rows[0]).filter((c) => !RAW_SKIP.has(c)) : [];
		return {
			cols,
			rows: rows.map((r) => cols.map((c) => round(r[c]) ?? null)),
			...(children ? { fight: rows.map((r) => rowOfFight.get(r.fight_id as number) ?? -1) } : {}),
		};
	};
	const body = JSON.stringify({
		player,
		fights: table(fightRows, false),
		swaps: table(swaps.results as Record<string, unknown>[], true),
		guns: table(guns.results as Record<string, unknown>[], true),
		combos: table(combos.results as Record<string, unknown>[], true),
	});
	// A row in leaderboard_views must stay well under D1's row size limit.
	if (body.length < 900_000) await storeView(env, key, body);
	return new Response(body, { headers });
}

/** Most swap rows sent with one player's fight list (newest first), so a huge history can't make an enormous reply. */
const MAX_SWAPS_IN_FIGHT_LIST = 5000;
/** Fights sent per request when a mod catches up with a history (?since=): it asks again while "more" is true. */
const SYNC_PAGE = 250;

/**
 * The ids of a player's newest n fights of each category (and of those with none), for `id IN (...)`. Reads n index rows per
 * category instead of ranking the whole history. Binds the uuid PER_CATEGORY_BINDS times.
 */
function newestPerCategory(n: number): string {
	const one = (where: string) => `SELECT id FROM (SELECT id FROM fights WHERE uuid = ? AND ${where} ORDER BY ended_at DESC, id DESC LIMIT ${n})`;
	return [...[...CATEGORIES].map((c) => one(`category = '${c}'`)), one("category IS NULL")].join(" UNION ALL ");
}
const PER_CATEGORY_BINDS = CATEGORIES.size + 1;

/** Fights with their swaps, gun totals and combo totals grouped under them; numbers tidied, the fight id kept only if asked. */
function groupFights(fights: Row[], swaps: Row[], guns: Row[], combos: Row[], keepId: boolean): Row[] {
	const byFight = (rows: Row[]) => {
		const groups = new Map<number, Row[]>();
		for (const row of rows) {
			const { fight_id, ...rest } = row;
			const id = fight_id as number;
			if (!groups.has(id)) groups.set(id, []);
			groups.get(id)!.push(round2(rest));
		}
		return groups;
	};
	const swapsByFight = byFight(swaps), gunsByFight = byFight(guns), combosByFight = byFight(combos);
	return fights.map((f) => {
		const { id, ...rest } = f;
		return {
			...(keepId ? { id } : {}),
			...rest,
			swaps: swapsByFight.get(id as number) ?? [],
			guns: gunsByFight.get(id as number) ?? [],
			combos: combosByFight.get(id as number) ?? [],
		};
	});
}

const FIGHT_LIST_SWAPS = `fight_id, ts, result, category, swap_type, total_ms, ${METRICS.join(", ")}`;
const FIGHT_LIST_GUNS = "fight_id, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps, net_shots, net_hits, net_headshots";
const FIGHT_LIST_COMBOS = "fight_id, category, enemy_combos, enemy_broken, own_combos, own_broken, enemy_first_hits, own_first_hits";

/**
 * One player's stored fights, each with its own swaps, gun totals and combo totals - the raw material for the fight log,
 * per-fight ratings and custom filters (fight count, opponents), which the mod works out itself. Only Wing and Air swaps are
 * sent (the only ones ever shown). Numbers are rounded to keep the reply small.
 *
 *   GET /players/:uuid/fights?since=ID   the mod keeps what it has read (FightCache) and asks only for fights stored after
 *       the last one it has: up to SYNC_PAGE fights with an id above ID, oldest first, each with its id; "cursor" is the id
 *       to ask from next and "more" says whether to ask again straight away. since=0 reads the whole history, page by page.
 *       "max_fights" is how many fights per category are kept (the mod drops older ones itself, as the backend does), and
 *       "epoch" changes when an admin deletes any of the player's data: the mod then throws its copy away and starts from 0.
 *       A fight is never changed once stored, so a repeat visit with nothing new costs two row reads.
 *   GET /players/:uuid/fights            mods from before that: the newest LEGACY_FIGHTS fights of each category, newest first.
 */
async function playerFights(request: Request, env: Env, uuid: string): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	const player = await env.DB.prepare("SELECT uuid, name, first_seen, last_seen, data_epoch FROM players WHERE uuid = ?")
		.bind(uuid)
		.first<{ uuid: string; name: string; first_seen: number; last_seen: number; data_epoch: number | null }>();
	if (!player) return json({ error: "no such player" }, 404);
	const { data_epoch, ...shown } = player;

	const since = new URL(request.url).searchParams.get("since");
	if (since !== null) {
		const cursor = Math.max(0, Math.trunc(Number(since)) || 0);
		const page = (await env.DB.prepare(
			`SELECT id, fight_key, started_at, ended_at, outcome, opponent, category, opponent_category
			   FROM fights WHERE uuid = ? AND id > ? ORDER BY id LIMIT ${SYNC_PAGE + 1}`,
		).bind(uuid, cursor).all<Row>()).results;
		const more = page.length > SYNC_PAGE;
		const fights = page.slice(0, SYNC_PAGE);
		let children: Row[][] = [[], [], []];
		if (fights.length > 0) {
			// Ids straight from the database, so they are safe to write into the SQL.
			const ids = fights.map((f) => Math.trunc(f.id as number)).join(", ");
			children = (await env.DB.batch<Row>([
				env.DB.prepare(`SELECT ${FIGHT_LIST_SWAPS} FROM swaps WHERE category IN ('WING', 'AIR') AND fight_id IN (${ids}) ORDER BY ts DESC`),
				env.DB.prepare(`SELECT ${FIGHT_LIST_GUNS} FROM fight_guns WHERE fight_id IN (${ids})`),
				env.DB.prepare(`SELECT ${FIGHT_LIST_COMBOS} FROM fight_combos WHERE fight_id IN (${ids})`),
			])).map((r) => r.results);
		}
		return json({
			...shown,
			epoch: data_epoch ?? 0,
			max_fights: MAX_FIGHTS,
			cursor: fights.length > 0 ? fights[fights.length - 1].id : cursor,
			more,
			fights: groupFights(fights, children[0], children[1], children[2], true),
		});
	}

	const kept = newestPerCategory(LEGACY_FIGHTS);
	const uuids = Array<string>(PER_CATEGORY_BINDS).fill(uuid);
	const [fights, swaps, guns, combos] = await env.DB.batch<Row>([
		env.DB.prepare(
			`SELECT id, fight_key, started_at, ended_at, outcome, opponent, category, opponent_category
			   FROM fights WHERE id IN (${kept}) ORDER BY ended_at DESC, id DESC`,
		).bind(...uuids),
		env.DB.prepare(
			`SELECT ${FIGHT_LIST_SWAPS} FROM swaps WHERE category IN ('WING', 'AIR') AND fight_id IN (${kept})
			  ORDER BY ts DESC LIMIT ${MAX_SWAPS_IN_FIGHT_LIST}`,
		).bind(...uuids),
		env.DB.prepare(`SELECT ${FIGHT_LIST_GUNS} FROM fight_guns WHERE fight_id IN (${kept})`).bind(...uuids),
		env.DB.prepare(`SELECT ${FIGHT_LIST_COMBOS} FROM fight_combos WHERE fight_id IN (${kept})`).bind(...uuids),
	]);
	return json({ ...shown, fights: groupFights(fights.results, swaps.results, guns.results, combos.results, false) });
}

// ---- Leaderboard ----

/** Most opponent names one leaderboard request may filter by. */
const MAX_OPPONENT_FILTER = 200;
/** Most opponents listed back for the mod's opponent chooser. */
const MAX_OPPONENTS_LISTED = 300;
/**
 * Leaderboards are recomputed at most this often per parameter set, to spare the database. Each view
 * is stored in the leaderboard_views table; an admin delete empties it so removed data disappears at
 * once. Personal stats are not stored.
 */
const LEADERBOARD_TTL_S = 300;

/** After an admin deletes all of a player's data: their stored leaderboard rows go too. */
async function clearLeaderboardRows(env: Env, uuid: string): Promise<void> {
	try {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM leaderboard_rows WHERE uuid = ?").bind(uuid),
			env.DB.prepare("DELETE FROM leaderboard_dirty WHERE uuid = ?").bind(uuid),
		]);
	} catch {
		// no table yet
	}
}

/** After an admin delete: stored leaderboards are dropped so the removed data disappears at once. */
export async function clearLeaderboards(env: Env): Promise<void> {
	try {
		await env.DB.prepare("DELETE FROM leaderboard_views").run();
	} catch {
		// no table yet
	}
}

/**
 * Everyone's stats for one PvP category, ready for the mod to rate and rank:
 *   GET /leaderboard?category=WING&fights=25&opponents=alice,bob
 * Each player is measured over their newest `fights` (1-MAX_FIGHTS) fights of that
 * category, counting only fights against `opponents` if any are given (names
 * matched ignoring case). Players with no such fights are left out. Each
 * entry is shaped like a /players/:uuid answer but carries only what that
 * category's ratings use (see Ratings in the mod):
 *   Wing   - Wing swap counts and averages (time, momentum)
 *   Air    - Air swaps by type
 *   Ground - movement gun speeds
 *   JP/Air - combo totals
 *   all    - gun totals for that category, K/D
 * Also lists the opponents seen in that window, for the mod's opponent filter.
 */
async function leaderboard(request: Request, env: Env): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);

	const params = new URL(request.url).searchParams;
	const category = params.get("category") ?? "";
	if (!CATEGORIES.has(category)) return json({ error: "bad category" }, 400);
	const asked = Number(params.get("fights"));
	const n = Number.isInteger(asked) && asked >= 1 && asked <= MAX_FIGHTS ? asked : DEFAULT_VIEW;
	const opponents = [
		...new Set(
			(params.get("opponents") ?? "")
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter((s) => /^[a-z0-9_]{1,16}$/.test(s)),
		),
	]
		.sort()
		.slice(0, MAX_OPPONENT_FILTER);

	return new Response(await leaderboardBody(env, category, n, opponents), { headers: { "Content-Type": "application/json" } });
}

/** How old a stored view may be served once the day's row budget is tight (see usage.ts): stored views live an hour at most. */
const TIGHT_TTL_S = 3600;

/**
 * One leaderboard view as JSON text. Every view is stored in D1 for LEADERBOARD_TTL_S (the Cache API does nothing on
 * workers.dev), so each view is worked out at most once per period, for everyone.
 */
async function leaderboardBody(env: Env, category: string, n: number, opponents: string[]): Promise<string> {
	const key = `${category}|${n}|${opponents.join(",")}`;
	const stored = await readStoredView(env, key, tightBudget() ? TIGHT_TTL_S : LEADERBOARD_TTL_S);
	if (stored) return stored;
	// Plain views of the usual sizes are put together from each player's stored row (rebuilding only the players whose
	// fights changed); opponent-filtered views and other sizes, or any trouble with the rows, compute in full.
	let body: string | null = null;
	if (opponents.length === 0 && ROW_WINDOWS.includes(n)) {
		try {
			body = await computeLeaderboardFromRows(env, category, n);
		} catch {
			body = null;
		}
	}
	body ??= await computeLeaderboard(env, category, n, opponents);
	if (!env.incomplete) await storeView(env, key, body);
	return body;
}

/** The opponents listed with a view: the most-fought first. */
function listOpponents(seen: Map<string, { name: string; fights: number }>): { key: string; name: string; fights: number }[] {
	return [...seen.entries()]
		.map(([key, v]) => ({ key, name: v.name, fights: v.fights }))
		.sort((a, b) => b.fights - a.fights || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.slice(0, MAX_OPPONENTS_LISTED);
}

/** Adds a stored row's _opp list ([key, name, fights]) to the opponents seen. */
function countOpponents(seen: Map<string, { name: string; fights: number }>, row: Row): void {
	for (const [key, name, count] of (row._opp ?? []) as [string, string, number][]) {
		const known = seen.get(key);
		if (!known) seen.set(key, { name, fights: count });
		else {
			known.fights += count;
			if (name > known.name) known.name = name;
		}
	}
}

/**
 * One leaderboard view worked out in full: each player's newest n fights of the category (against the given opponents, if any),
 * one row read per fight looked at. With an opponent filter only the fights against those names are read (index
 * fights_category_opponent); without one it is every fight of the category, which is why plain views use the stored rows instead.
 */
export async function computeLeaderboard(env: Env, category: string, n: number, opponents: string[]): Promise<string> {
	// category, n and the names are validated by the caller, so they're safe to write into the SQL.
	const opponentClause = opponents.length ? ` AND lower(opponent) IN (${opponents.map((o) => `'${o}'`).join(", ")})` : "";
	// Left to itself SQLite walks the whole category in player order (it suits the ranking); told to, it reads only the fights against those names.
	const byOpponent = opponents.length ? " INDEXED BY fights_category_opponent" : "";
	const [picked, people] = await env.DB.batch<Row>([
		env.DB.prepare(
			`SELECT ${FIGHT_COLUMNS} FROM (
			   SELECT ${FIGHT_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY ended_at DESC, id DESC) AS rn
			     FROM fights${byOpponent} WHERE category = '${category}'${opponentClause})
			  WHERE rn <= ${n} ORDER BY uuid, ended_at DESC, id DESC`,
		),
		env.DB.prepare("SELECT uuid, name, first_seen, last_seen FROM players"),
	]);
	const fights = picked.results as unknown as StoredFight[];
	await healSummaries(env, fights);
	const byPlayer = new Map<string, Totals>();
	for (const f of fights) {
		let totals = byPlayer.get(f.uuid as string);
		if (!totals) byPlayer.set(f.uuid as string, (totals = new Totals()));
		totals.add(f);
	}

	const seen = new Map<string, { name: string; fights: number }>();
	const players: Row[] = [];
	for (const p of (people.results as { uuid: string; name: string; first_seen: number; last_seen: number }[]).sort((a, b) => (a.uuid < b.uuid ? -1 : 1))) {
		const row = byPlayer.get(p.uuid)?.leaderboardRow(category);
		if (!row) continue;
		countOpponents(seen, row);
		delete row._opp;
		players.push(round2({ uuid: p.uuid, name: p.name, first_seen: p.first_seen, last_seen: p.last_seen, ...row }));
	}
	// The opponent chooser lists who was fought in the plain view, whatever the filter is.
	const listed = opponents.length === 0
		? listOpponents(seen)
		: (JSON.parse(await leaderboardBody(env, category, n, [])) as { opponents: unknown[] }).opponents;
	return JSON.stringify({ category, fights: n, players, opponents: listed });
}

// ---- Leaderboard rows per player ----

/** The view sizes whose per-player rows are kept (leaderboard_rows, migration 0015). */
const ROW_WINDOWS = [25, 50, 100, 250, 500];
/** Most players rebuilt in one request: each costs two database calls and adds up to MAX_FIGHTS summaries. */
const MAX_REBUILDS_PER_REQUEST = 6;
/**
 * A player whose fights changed keeps their stored rows for this long before they are rebuilt (a rebuild reads up to 500 fights), so a
 * player uploading every few minutes costs one rebuild per period, not one per leaderboard view. A player with no rows is built at once.
 */
const REBUILD_MIN_AGE_S = 300;

/** Marks a player's rows for one category as out of date (their fights there changed). */
function dirtyStatement(env: Env, uuid: string, category: string): D1PreparedStatement {
	return env.DB.prepare("INSERT OR REPLACE INTO leaderboard_dirty (uuid, category, marked_at) VALUES (?, ?, ?)").bind(uuid, category, Date.now());
}

/**
 * Works out one player's rows (every view size, from one read of their newest MAX_FIGHTS fights) for a category and stores
 * them; clears their dirty mark (if one is given) unless it has been re-marked since.
 */
async function rebuildPlayerRows(env: Env, uuid: string, category: string, markedAt: number | null): Promise<void> {
	const fights = (await newestFights(env, uuid, MAX_FIGHTS, category).all<StoredFight>()).results;
	await healSummaries(env, fights);
	const now = Date.now();
	const writes: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM leaderboard_rows WHERE uuid = ? AND category = ?").bind(uuid, category)];
	for (const n of ROW_WINDOWS) {
		const row = totalsOf(fights, n).leaderboardRow(category);
		if (row) {
			writes.push(env.DB.prepare("INSERT INTO leaderboard_rows (uuid, category, n, row, built_at) VALUES (?, ?, ?, ?, ?)")
				.bind(uuid, category, n, JSON.stringify(row), now));
		}
	}
	// Under the limit the read above saw every fight, so the kept count can be put right for free.
	if (fights.length < MAX_FIGHTS) {
		writes.push(env.DB.prepare("INSERT OR REPLACE INTO fight_counts (uuid, category, fights) VALUES (?, ?, ?)").bind(uuid, category, fights.length));
	}
	// Only if no fight was uploaded meanwhile (it would have set a newer mark).
	if (markedAt !== null) {
		writes.push(env.DB.prepare("DELETE FROM leaderboard_dirty WHERE uuid = ? AND category = ? AND marked_at <= ?").bind(uuid, category, markedAt));
	}
	await env.DB.batch(writes);
}

/**
 * A plain leaderboard view from the stored per-player rows: first rebuilds the (few) players whose fights changed, and any
 * who have fights but no row of this size (a size added later), then reads one row each. Returns null when the rows cannot
 * be complete yet (more players waiting than one request may rebuild), so the caller computes the view in full; the players
 * rebuilt here stay rebuilt, so a few requests later the rows are complete.
 */
export async function computeLeaderboardFromRows(env: Env, category: string, n: number): Promise<string | null> {
	const dirty = await env.DB.prepare(
		`SELECT d.uuid, d.marked_at FROM leaderboard_dirty d WHERE d.category = ?
		   AND NOT EXISTS (SELECT 1 FROM leaderboard_rows r WHERE r.uuid = d.uuid AND r.category = d.category AND r.built_at > ?)
		  ORDER BY d.marked_at LIMIT ?`,
	)
		.bind(category, Date.now() - REBUILD_MIN_AGE_S * 1000, MAX_REBUILDS_PER_REQUEST)
		.all<{ uuid: string; marked_at: number }>();
	for (const d of dirty.results) await rebuildPlayerRows(env, d.uuid, category, d.marked_at);

	const rowless = `FROM fight_counts c WHERE c.category = ? AND c.fights > 0
		AND NOT EXISTS (SELECT 1 FROM leaderboard_rows r WHERE r.uuid = c.uuid AND r.category = c.category AND r.n = ?)`;
	const room = MAX_REBUILDS_PER_REQUEST - dirty.results.length;
	if (room > 0) {
		const waiting = await env.DB.prepare(`SELECT c.uuid ${rowless} LIMIT ?`).bind(category, n, room).all<{ uuid: string }>();
		const done = new Set(dirty.results.map((d) => d.uuid));
		for (const w of waiting.results) if (!done.has(w.uuid)) await rebuildPlayerRows(env, w.uuid, category, null);
	}
	if (await env.DB.prepare(`SELECT 1 AS x ${rowless} LIMIT 1`).bind(category, n).first()) return null;

	const { results } = await env.DB.prepare(
		`SELECT r.uuid, r.row, p.name, p.first_seen, p.last_seen
		   FROM leaderboard_rows r JOIN players p ON p.uuid = r.uuid
		  WHERE r.category = ? AND r.n = ? ORDER BY r.uuid`,
	).bind(category, n).all<{ uuid: string; row: string; name: string; first_seen: number; last_seen: number }>();

	const seen = new Map<string, { name: string; fights: number }>();
	const players = results.map((r) => {
		const row = JSON.parse(r.row) as Row;
		countOpponents(seen, row);
		delete row._opp;
		return round2({ uuid: r.uuid, name: r.name, first_seen: r.first_seen, last_seen: r.last_seen, ...row });
	});
	return JSON.stringify({ category, fights: n, players, opponents: listOpponents(seen) });
}

export async function readStoredView(env: Env, key: string, ttlSeconds = LEADERBOARD_TTL_S): Promise<string | null> {
	try {
		const row = await env.DB.prepare("SELECT body FROM leaderboard_views WHERE key = ? AND computed_at > ?")
			.bind(key, Date.now() - ttlSeconds * 1000)
			.first<{ body: string }>();
		return row?.body ?? null;
	} catch {
		return null; // table not created yet: compute every time
	}
}

export async function storeView(env: Env, key: string, body: string): Promise<void> {
	try {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("INSERT OR REPLACE INTO leaderboard_views (key, body, computed_at) VALUES (?, ?, ?)").bind(key, body, now),
			// Drop views nobody has asked for in an hour (filtered views pile up otherwise).
			env.DB.prepare("DELETE FROM leaderboard_views WHERE computed_at < ?").bind(now - 3_600_000),
		]);
	} catch {
		// see readStoredView
	}
}

// ---- Admin: deleting stats data ----

/** A player's stored fights changed other than by a new one arriving: mods holding a copy of them (FightCache) must start again. */
function epochStatement(env: Env, uuid: string): D1PreparedStatement {
	return env.DB.prepare("UPDATE players SET data_epoch = COALESCE(data_epoch, 0) + 1 WHERE uuid = ?").bind(uuid);
}

/** The logged-in admin's UUID, or a ready 401 / 403 response. */
async function requireAdmin(request: Request, env: Env): Promise<{ admin: string } | { denied: Response }> {
	const uuid = await authenticate(request, env);
	if (!uuid) return { denied: json({ error: "not logged in" }, 401) };
	if (!isAdmin(env, uuid)) return { denied: json({ error: "admin access only" }, 403) };
	return { admin: uuid };
}

// ---- Flags: stats that are out of the norm (admin Player info) ----
// Every rule has a minimum sample size, so a handful of lucky shots or swaps is never flagged. The limits come from the real
// numbers of the players so far (2026-10-05): fastest Wing swap 105 ms, average 158 ms at best; mouse path efficiency 71-84%;
// speed before a Wing swap tops out around 32 b/s; hit rate at most 19% with 100+ shots; headshots 11-30% of hits.
const FLAG_FAST_SWAP_MS = 100;
const FLAG_HIGH_SPEED_BPS = 40;

interface SwapFlagRow {
	category: string; n: number; fastest: number; under_fast: number; avg_ms: number; avg_efficiency: number | null; n_efficiency: number;
	fast_start: number; n_speed: number; sum_before: number | null; sum_after: number | null;
}
interface GunFlagRow { gun: string; shots: number; hits: number; headshots: number }
interface Flag { level: "warn" | "note"; text: string }
/** What each flag needs before it shows, in words (admin Player info > Flag rules). Keep in step with playerFlags / cursorFlags / inputFlags. */
export function flagRules(): { title: string; requirement: string }[] {
	return [
		{ title: "Fast swaps (Wing, Air)", requirement: `Any single successful swap of that kind under ${FLAG_FAST_SWAP_MS} ms (no minimum number of swaps).` },
		{ title: "Fast average swap", requirement: "At least 20 successful swaps of that kind and an average swap time under 120 ms." },
		{ title: "Mouse path efficiency", requirement: "At least 20 swaps with an efficiency reading and an average of 92% or more (normal is 70-85%)." },
		{ title: "Fast start speed", requirement: `2 or more swaps that started above ${FLAG_HIGH_SPEED_BPS} blocks/s (others top out around 32).` },
		{ title: "Speed kept", requirement: "At least 8 swaps with a speed before and after, and the speed after adds up to more than 105% of the speed before (it cannot exceed 100%)." },
		{ title: "Gun hit rate", requirement: "At least 150 shots with one gun (the Net Launcher is skipped) and a hit rate of 50% or more." },
		{ title: "Gun headshots", requirement: "At least 80 hits with one gun and headshots making up 45% or more of them." },
		{ title: "K/D (a note, not a warning)", requirement: "At least 30 fights and a K/D of 6 or more; or 20 or more kills with no deaths over 30+ fights." },
		{ title: "Cursor started near the chest slot", requirement: "At least 15 successful Wing / Air swaps of that kind with a distance reading; on 3 or more of them and 5% or more, the cursor needed under 20% of the player's usual travel distance (the median)." },
		{ title: "Cursor reached the slot instantly", requirement: "The same 15 swaps minimum; 3 or more reached the slot in under 25 ms (the quickest real one is 40 ms)." },
		{ title: "Cursor path shorter than possible", requirement: "The same 15 swaps minimum; on 3 or more and 5% or more, the cursor path was under half the straight line (swaps needing at least 1 degree of travel)." },
		{ title: "Cursor not at the window centre", requirement: "Input checks use a player's latest 300 swaps: only survival-inventory swaps opened from gameplay count, and at least 10 of them. Flags when the cursor was more than 3 px off the window centre on 3 or more swaps and 5% or more." },
		{ title: "Inventory not where vanilla draws it", requirement: "The same 10 swaps minimum. The inventory must be vertically centred and horizontally either centred (recipe book closed) or shifted by the open recipe book, within 3 scaled px; 3 or more swaps and 5% or more outside that are flagged (a mod that moves the inventory)." },
		{ title: "Cursor started on the chest slot", requirement: "The same 10 swaps minimum; 3 or more and 5% or more with the cursor within 12 scaled px of the slot when the inventory opened (the recipe book never does this)." },
		{ title: "Cursor path under half (pixels)", requirement: "The same 10 swaps minimum; 3 or more and 5% or more where the slot was at least 40 px away and the travelled path was under half the straight line." },
		{ title: "Recipe book / GUI scale (a note)", requirement: "Shown whenever the 10 input swaps exist: how often the recipe book was open and which GUI scales the player uses." },
	];
}

/** How long the list of flagged players is kept before it is worked out again (it reads about 50 000 rows). */
const FLAGGED_TTL_S = 3600;

/**
 * Admin mode: every player who has at least one warning flag, with all of their flags (the same rules as Player info), the most
 * warnings first. Worked out from whole-table queries - five of them in one batch, about 30 000 rows read - and kept in
 * leaderboard_views for FLAGGED_TTL_S, so opening the list repeatedly costs one row.
 */
async function adminFlagged(request: Request, env: Env): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;
	const headers = { "Content-Type": "application/json" };
	const stored = await readStoredView(env, "flagged-players", tightBudget() ? TIGHT_TTL_S : FLAGGED_TTL_S);
	if (stored) return new Response(stored, { headers });

	const [players, swapStats, gunStats, fightStats, cursorRows, inputRows] = await env.DB.batch([
		env.DB.prepare("SELECT uuid, name FROM players"),
		env.DB.prepare(
			`SELECT uuid, category, COUNT(*) AS n, MIN(total_ms) AS fastest, COALESCE(SUM(total_ms < ${FLAG_FAST_SWAP_MS}), 0) AS under_fast, AVG(total_ms) AS avg_ms,
			        AVG(efficiency) AS avg_efficiency, COUNT(efficiency) AS n_efficiency,
			        COALESCE(SUM(speed_before_bps > ${FLAG_HIGH_SPEED_BPS}), 0) AS fast_start,
			        COALESCE(SUM(speed_before_bps IS NOT NULL AND speed_after_bps IS NOT NULL), 0) AS n_speed,
			        SUM(CASE WHEN speed_after_bps IS NOT NULL THEN speed_before_bps END) AS sum_before, SUM(speed_after_bps) AS sum_after
			   FROM swaps WHERE result = 'SUCCESS' AND category IN ('WING', 'AIR') GROUP BY uuid, category`,
		),
		env.DB.prepare("SELECT uuid, gun, SUM(shots) AS shots, SUM(hits) AS hits, SUM(headshots) AS headshots FROM fight_guns GROUP BY uuid, gun"),
		env.DB.prepare(
			"SELECT uuid, COUNT(*) AS fights, COALESCE(SUM(outcome = 'KILL'), 0) AS kills, COALESCE(SUM(outcome = 'DEATH'), 0) AS deaths FROM fights GROUP BY uuid",
		),
		env.DB.prepare(
			"SELECT uuid, category, needed_deg, approach_deg, reach_ms FROM swaps WHERE result = 'SUCCESS' AND category IN ('WING', 'AIR') AND needed_deg IS NOT NULL",
		),
		env.DB.prepare(`SELECT uuid, category, ${INPUT_METRICS.join(", ")} FROM swaps WHERE cursor_dx IS NOT NULL ORDER BY ts DESC`),
	]);

	const group = <T extends { uuid: string }>(rows: T[]): Map<string, T[]> => {
		const map = new Map<string, T[]>();
		for (const row of rows) {
			const list = map.get(row.uuid);
			if (list) list.push(row);
			else map.set(row.uuid, [row]);
		}
		return map;
	};
	const swapsBy = group(swapStats.results as (SwapFlagRow & { uuid: string })[]);
	const gunsBy = group(gunStats.results as (GunFlagRow & { uuid: string })[]);
	const cursorBy = group(cursorRows.results as (CursorRow & { uuid: string })[]);
	const inputBy = group(inputRows.results as (InputRow & { uuid: string })[]);
	const fightsBy = new Map((fightStats.results as { uuid: string; fights: number; kills: number; deaths: number }[]).map((r) => [r.uuid, r]));

	const flagged: { uuid: string; name: string; flags: Flag[] }[] = [];
	for (const p of players.results as { uuid: string; name: string }[]) {
		const f = fightsBy.get(p.uuid);
		const flags = [
			...playerFlags(swapsBy.get(p.uuid) ?? [], gunsBy.get(p.uuid) ?? [], f?.fights ?? 0, f?.kills ?? 0, f?.deaths ?? 0),
			...cursorFlags(cursorBy.get(p.uuid) ?? []),
			...inputFlags((inputBy.get(p.uuid) ?? []).slice(0, 300)),
		];
		if (flags.some((x) => x.level === "warn")) flagged.push({ uuid: p.uuid, name: p.name, flags });
	}
	const warnings = (p: { flags: Flag[] }) => p.flags.filter((x) => x.level === "warn").length;
	flagged.sort((a, b) => warnings(b) - warnings(a) || a.name.localeCompare(b.name));
	const body = JSON.stringify({ players: flagged, computed_at: Date.now() });
	await storeView(env, "flagged-players", body);
	console.log(JSON.stringify({ event: "admin_flagged", admin: auth.admin, flagged: flagged.length }));
	return new Response(body, { headers });
}

/** Admin mode: the list above, for the Flag rules view. No database reads. */
async function adminFlagRules(request: Request, env: Env): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;
	return json({ rules: flagRules() });
}

interface InputRow {
	category: string; cursor_dx: number; cursor_dy: number; direct_px: number | null; approach_px: number | null;
	gui_x: number; gui_y: number; scaled_w: number; scaled_h: number; gui_scale: number; creative: number; from_screen: number;
}

/**
 * Where vanilla puts the survival inventory (InventoryScreen / RecipeBookWidget.findLeftEdge): y is centred; x is centred when the
 * recipe book is closed (or the window is narrow, under 379 scaled px) and shifted right by the open book otherwise.
 */
export function vanillaInventoryPosition(scaledW: number, scaledH: number): { y: number; closedX: number; bookX: number } {
	const closedX = Math.floor((scaledW - 176) / 2);
	return { y: Math.floor((scaledH - 166) / 2), closedX, bookX: scaledW < 379 ? closedX : 177 + Math.floor((scaledW - 176 - 200) / 2) };
}

/**
 * Input tricks, from how the inventory opened (pixels, so none of this depends on mouse sensitivity). Only survival-inventory swaps
 * that opened from gameplay count, and at least 10 of them. Vanilla puts the cursor exactly on the window centre and the inventory
 * in one of two places (recipe book closed or open, which legally puts the cursor beside the lower armor slots), so:
 *  - the cursor not on the centre (more than 3 px off) means the game's cursor reset was bypassed;
 *  - the inventory not where vanilla draws it (e.g. moved down by a mod to put the slot under the cursor);
 *  - the cursor already on (or within 12 scaled px of) the slot at open, which the recipe book never does;
 *  - a cursor path to the slot shorter than half the straight line, or no movement at all although the slot was far away.
 */
export function inputFlags(rows: InputRow[]): Flag[] {
	const flags: Flag[] = [];
	const mine = rows.filter((r) => r.creative === 0 && r.from_screen === 0 && Number.isFinite(r.gui_scale) && r.gui_scale > 0);
	if (mine.length < 10) return flags;
	let book = 0;
	for (const r of mine) {
		const v = vanillaInventoryPosition(r.scaled_w, r.scaled_h);
		if (Math.abs(r.gui_x - v.bookX) <= 3 && Math.abs(r.gui_x - v.closedX) > 3) book++;
	}
	const rule = (count: number, text: string) => {
		if (count >= 3 && count / mine.length >= 0.05) flags.push({ level: "warn", text: `${text} on ${count} of ${mine.length} swaps` });
	};
	rule(mine.filter((r) => Math.hypot(r.cursor_dx, r.cursor_dy) > 3).length, "The cursor did not start at the window centre (more than 3 px off)");
	rule(mine.filter((r) => {
		const v = vanillaInventoryPosition(r.scaled_w, r.scaled_h);
		return Math.abs(r.gui_y - v.y) > 3 || (Math.abs(r.gui_x - v.closedX) > 3 && Math.abs(r.gui_x - v.bookX) > 3);
	}).length, "The inventory was not where vanilla draws it");
	rule(mine.filter((r) => r.direct_px !== null && r.direct_px < 12 * r.gui_scale).length, "The cursor started on the chest slot (within 12 scaled px)");
	rule(mine.filter((r) => r.direct_px !== null && r.approach_px !== null && r.direct_px >= 40 && r.approach_px < 0.5 * r.direct_px).length,
		"The cursor's path to the slot was under half the straight-line distance");
	const scales = [...new Set(mine.map((r) => r.gui_scale))].sort((a, b) => a - b);
	flags.push({ level: "note", text: `Recipe book open on ${book} of ${mine.length} swaps (GUI scale ${scales.join(", ")})` });
	return flags;
}

interface CursorRow { category: string; needed_deg: number; approach_deg: number | null; reach_ms: number | null }

/**
 * Cursor tricks (see the comment above FLAG_FAST_SWAP_MS for the sample-size idea). In vanilla the cursor starts at the centre of the
 * screen each time the inventory opens, so the distance it must travel to the chest slot (needed_deg) is nearly the same on every swap
 * of a player (it differs between players with window size, GUI scale and sensitivity: 1.7-8.2 degrees so far). So:
 *  - swaps that needed much less travel than this player's usual (under 20% of their median) mean the cursor did not start in the
 *    centre but on or near the slot (a bug, a mod that keeps the cursor, a macro...). The recipe book is legal and moves the start
 *    to about 60% of the closed-book distance (the inventory slides right, the cursor still starts at the screen centre), so it is
 *    well clear of this line; the data shows it too: players sit in groups about 0.55-0.6 apart;
 *  - reaching the slot in under 25 ms (the quickest real one is 40 ms);
 *  - a path to the slot shorter than half the straight line is not possible with a real mouse.
 * Changing window size or GUI scale between swaps can also move the typical value, hence "check".
 */
export function cursorFlags(rows: CursorRow[]): Flag[] {
	const flags: Flag[] = [];
	for (const category of ["WING", "AIR"]) {
		const mine = rows.filter((r) => r.category === category);
		const label = category === "WING" ? "Wing" : "Air";
		if (mine.length < 15) continue;
		const needed = mine.map((r) => r.needed_deg).sort((a, b) => a - b);
		const median = needed[Math.floor(needed.length / 2)];
		const close = mine.filter((r) => r.needed_deg < 0.2 * median);
		if (close.length >= 3 && close.length / mine.length >= 0.05) {
			const least = Math.min(...close.map((r) => r.needed_deg));
			flags.push({ level: "warn", text: `${label}: the cursor started near the chest slot on ${close.length} of ${mine.length} swaps (needed ${least.toFixed(1)}\u00B0 vs usually ${median.toFixed(1)}\u00B0; check window size changes)` });
		}
		const instant = mine.filter((r) => r.reach_ms !== null && r.reach_ms < 25);
		if (instant.length >= 3) {
			flags.push({ level: "warn", text: `${label}: the cursor reached the slot in under 25 ms on ${instant.length} of ${mine.length} swaps (quickest real: 40 ms)` });
		}
		const shortPath = mine.filter((r) => r.approach_deg !== null && r.needed_deg >= 1 && r.approach_deg < 0.5 * r.needed_deg);
		if (shortPath.length >= 3 && shortPath.length / mine.length >= 0.05) {
			flags.push({ level: "warn", text: `${label}: the cursor's path to the slot was under half the straight-line distance on ${shortPath.length} of ${mine.length} swaps` });
		}
	}
	return flags;
}

export function playerFlags(swaps: SwapFlagRow[], guns: GunFlagRow[], fights: number, kills: number, deaths: number): Flag[] {
	const flags: Flag[] = [];
	for (const s of swaps) {
		const label = s.category === "WING" ? "Wing" : "Air";
		if (s.under_fast >= 1) {
			flags.push({ level: "warn", text: `${label} swaps under ${FLAG_FAST_SWAP_MS} ms: ${s.under_fast} of ${s.n} (fastest ${Math.round(s.fastest)} ms)` });
		}
		if (s.n >= 20 && s.avg_ms < 120) {
			flags.push({ level: "warn", text: `${label} swaps average ${Math.round(s.avg_ms)} ms over ${s.n} swaps (the quickest others get is about 160)` });
		}
		if (s.n_efficiency >= 20 && s.avg_efficiency !== null && s.avg_efficiency >= 92) {
			flags.push({ level: "warn", text: `${label} mouse path efficiency averages ${Math.round(s.avg_efficiency)}% over ${s.n_efficiency} swaps (usually 70-85%)` });
		}
		if (s.fast_start >= 2) {
			flags.push({ level: "warn", text: `${s.fast_start} ${label} swaps started above ${FLAG_HIGH_SPEED_BPS} b/s (others top out around 32)` });
		}
		if (s.n_speed >= 8 && s.sum_before && s.sum_after !== null && s.sum_after / s.sum_before > 1.05) {
			flags.push({ level: "warn", text: `${label} speed kept averages ${Math.round((100 * s.sum_after) / s.sum_before)}% over ${s.n_speed} swaps (it cannot exceed 100%)` });
		}
	}
	for (const g of guns) {
		if (/net launcher/i.test(g.gun)) continue;
		if (g.shots >= 150 && g.hits / g.shots >= 0.5) {
			flags.push({ level: "warn", text: `${g.gun}: ${Math.round((100 * g.hits) / g.shots)}% hit rate over ${g.shots} shots (others reach about 20%)` });
		}
		if (g.hits >= 80 && g.headshots / g.hits >= 0.45) {
			flags.push({ level: "warn", text: `${g.gun}: headshots are ${Math.round((100 * g.headshots) / g.hits)}% of ${g.hits} hits (usually 10-30%)` });
		}
	}
	if (fights >= 30 && deaths > 0 && kills / deaths >= 6) {
		flags.push({ level: "note", text: `K/D ${(kills / deaths).toFixed(1)} over ${fights} fights (very high)` });
	} else if (fights >= 30 && deaths === 0 && kills >= 20) {
		flags.push({ level: "note", text: `${kills} kills and no deaths over ${fights} fights` });
	}
	return flags;
}

/**
 * Admin mode: what the backend knows about one player, by name (ignoring case) or by uuid:
 *   GET /admin/player-info?name=Steve     GET /admin/player-info?uuid=<32 hex>
 * Several players with the same name (a changed name): the one seen most recently.
 */
/** How long one player's admin info is kept before it is worked out again. */
const PLAYER_INFO_TTL_S = 900;

async function adminPlayerInfo(request: Request, env: Env): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;

	const params = new URL(request.url).searchParams;
	const uuidParam = normalizeUuid(params.get("uuid") ?? "");
	const name = (params.get("name") ?? "").trim();
	let player: { uuid: string; name: string; first_seen: number; last_seen: number; mod_version: string | null } | null = null;
	if (/^[0-9a-f]{32}$/.test(uuidParam)) {
		player = await env.DB.prepare("SELECT uuid, name, first_seen, last_seen, mod_version FROM players WHERE uuid = ?").bind(uuidParam).first();
	} else if (/^[A-Za-z0-9_]{1,16}$/.test(name)) {
		player = await env.DB.prepare(
			"SELECT uuid, name, first_seen, last_seen, mod_version FROM players WHERE lower(name) = lower(?) ORDER BY last_seen DESC LIMIT 1",
		).bind(name).first();
	} else {
		return json({ error: "give a player name (1-16 letters, digits, _) or a uuid" }, 400);
	}
	if (!player) return json({ error: "no such player" }, 404);

	// The same player's info asked again within PLAYER_INFO_TTL_S is the stored answer (the queries below read about 5 000 rows).
	// Only 'online' is worked out again. An admin delete empties the stored views (clearLeaderboards), so removed data shows at once.
	const infoKey = `player-info-${player.uuid}`;
	const storedInfo = await readStoredView(env, infoKey, tightBudget() ? TIGHT_TTL_S : PLAYER_INFO_TTL_S);
	if (storedInfo) {
		const info = JSON.parse(storedInfo) as Record<string, unknown>;
		info.online = player.last_seen >= Date.now() - PRESENCE_WINDOW_MS;
		info.last_seen = player.last_seen;
		return json(info);
	}

	const [byCategory, last, swaps, swapStats, gunStats, cursorRows, inputRows] = await env.DB.batch([
		env.DB.prepare(
			`SELECT category, COUNT(*) AS fights, COALESCE(SUM(outcome = 'KILL'), 0) AS kills, COALESCE(SUM(outcome = 'DEATH'), 0) AS deaths
			   FROM fights WHERE uuid = ? GROUP BY category`,
		).bind(player.uuid),
		env.DB.prepare("SELECT MAX(ended_at) AS last_fight_at FROM fights WHERE uuid = ?").bind(player.uuid),
		env.DB.prepare("SELECT COUNT(*) AS swaps FROM swaps WHERE uuid = ?").bind(player.uuid),
		// For the flags: successful Wing and Air swaps, and gun totals.
		env.DB.prepare(
			`SELECT category, COUNT(*) AS n, MIN(total_ms) AS fastest, COALESCE(SUM(total_ms < ${FLAG_FAST_SWAP_MS}), 0) AS under_fast, AVG(total_ms) AS avg_ms,
			        AVG(efficiency) AS avg_efficiency, COUNT(efficiency) AS n_efficiency,
			        COALESCE(SUM(speed_before_bps > ${FLAG_HIGH_SPEED_BPS}), 0) AS fast_start,
			        COALESCE(SUM(speed_before_bps IS NOT NULL AND speed_after_bps IS NOT NULL), 0) AS n_speed,
			        SUM(CASE WHEN speed_after_bps IS NOT NULL THEN speed_before_bps END) AS sum_before, SUM(speed_after_bps) AS sum_after
			   FROM swaps WHERE uuid = ? AND result = 'SUCCESS' AND category IN ('WING', 'AIR') GROUP BY category`,
		).bind(player.uuid),
		env.DB.prepare(
			`SELECT gun, SUM(shots) AS shots, SUM(hits) AS hits, SUM(headshots) AS headshots FROM fight_guns WHERE uuid = ? GROUP BY gun`,
		).bind(player.uuid),
		// For the cursor flags: how each successful swap's cursor travelled (at most a few hundred rows).
		env.DB.prepare(
			`SELECT category, needed_deg, approach_deg, reach_ms FROM swaps
				  WHERE uuid = ? AND result = 'SUCCESS' AND category IN ('WING', 'AIR') AND needed_deg IS NOT NULL`,
		).bind(player.uuid),
		// For the input flags: how the inventory opened in the player's latest swaps (the mod records this since 1.4.0).
		env.DB.prepare(
			`SELECT category, ${INPUT_METRICS.join(", ")} FROM swaps WHERE uuid = ? AND cursor_dx IS NOT NULL ORDER BY ts DESC LIMIT 300`,
		).bind(player.uuid),
	]);
	const categories = (byCategory.results ?? []) as { category: string | null; fights: number; kills: number; deaths: number }[];
	const fightsByCategory: Record<string, number> = {};
	let fights = 0, kills = 0, deaths = 0;
	for (const c of categories) {
		fightsByCategory[c.category ?? "UNKNOWN"] = c.fights;
		fights += c.fights;
		kills += c.kills;
		deaths += c.deaths;
	}
	console.log(JSON.stringify({ event: "admin_player_info", admin: auth.admin, target: player.uuid, name: player.name }));
	const info = {
		uuid: player.uuid,
		name: player.name,
		first_seen: player.first_seen,
		last_seen: player.last_seen,
		mod_version: player.mod_version,
		online: player.last_seen >= Date.now() - PRESENCE_WINDOW_MS,
		dev: isDev(env, player.uuid),
		admin: isAdmin(env, player.uuid),
		fights,
		kills,
		deaths,
		fights_by_category: fightsByCategory,
		last_fight_at: ((last.results?.[0] as { last_fight_at: number | null } | undefined)?.last_fight_at) ?? null,
		swaps: ((swaps.results?.[0] as { swaps: number } | undefined)?.swaps) ?? 0,
		flags: [...playerFlags(swapStats.results as SwapFlagRow[], gunStats.results as GunFlagRow[], fights, kills, deaths), ...cursorFlags(cursorRows.results as CursorRow[]), ...inputFlags(inputRows.results as InputRow[])],
	};
	await storeView(env, infoKey, JSON.stringify(info));
	return json(info);
}

/**
 * Deletes ALL of a player's stats: every fight with its swaps, gun totals and
 * combo totals. The player and their login stay, so they can keep uploading
 * (a new fight starts their stats again). Cannot be undone.
 */
async function adminDeletePlayerData(request: Request, env: Env, target: string): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;

	const player = await env.DB.prepare("SELECT name FROM players WHERE uuid = ?").bind(target).first<{ name: string }>();
	if (!player) return json({ error: "no such player" }, 404);
	const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM fights WHERE uuid = ?").bind(target).first<{ n: number }>();

	await env.DB.batch([
		env.DB.prepare("DELETE FROM swaps WHERE uuid = ?").bind(target),
		env.DB.prepare("DELETE FROM fight_guns WHERE uuid = ?").bind(target),
		env.DB.prepare("DELETE FROM fight_combos WHERE uuid = ?").bind(target),
		env.DB.prepare("DELETE FROM fights WHERE uuid = ?").bind(target),
		env.DB.prepare("DELETE FROM fight_counts WHERE uuid = ?").bind(target),
		epochStatement(env, target),
	]);
	await clearLeaderboardRows(env, target);
	await clearLeaderboards(env);
	// The worker's log is the audit trail.
	console.log(JSON.stringify({ event: "admin_delete_player_data", admin: auth.admin, target, name: player.name, fights: before?.n ?? 0 }));
	return json({ deleted_fights: before?.n ?? 0 });
}

/** Deletes one fight (and its swaps, gun and combo totals) from a player's stats. Cannot be undone. */
async function adminDeleteFight(request: Request, env: Env, target: string, fightKey: string): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if ("denied" in auth) return auth.denied;

	const fight = await env.DB.prepare("SELECT id, opponent, outcome, category FROM fights WHERE uuid = ? AND fight_key = ?")
		.bind(target, fightKey)
		.first<{ id: number; opponent: string | null; outcome: string; category: string | null }>();
	if (!fight) return json({ error: "no such fight" }, 404);

	await env.DB.batch([
		env.DB.prepare("DELETE FROM swaps WHERE fight_id = ?").bind(fight.id),
		env.DB.prepare("DELETE FROM fight_guns WHERE fight_id = ?").bind(fight.id),
		env.DB.prepare("DELETE FROM fight_combos WHERE fight_id = ?").bind(fight.id),
		env.DB.prepare("DELETE FROM fights WHERE id = ?").bind(fight.id),
		env.DB.prepare("UPDATE fight_counts SET fights = MAX(0, fights - 1) WHERE uuid = ? AND category = ?").bind(target, fight.category ?? ""),
		epochStatement(env, target),
	]);
	if (fight.category) {
		try {
			await env.DB.prepare("DELETE FROM leaderboard_rows WHERE uuid = ? AND category = ?").bind(target, fight.category).run();
			await dirtyStatement(env, target, fight.category).run();
		} catch {
			// no table yet
		}
	}
	await clearLeaderboards(env);
	console.log(JSON.stringify({ event: "admin_delete_fight", admin: auth.admin, target, fight_key: fightKey, opponent: fight.opponent, outcome: fight.outcome, category: fight.category }));
	return json({ deleted_fights: 1 });
}

// ---- Helpers ----

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function readJson(request: Request): Promise<any> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function countOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base64OrNull(value: unknown): Uint8Array | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
	try {
		return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

function normalizeUuid(uuid: string): string {
	return uuid.toLowerCase().replace(/-/g, "");
}

function randomHex(bytes: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
