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
 *   GET  /players/:uuid/fights -> one player's last MAX_FIGHTS fights per category, raw, newest first (logged in)
 *   GET  /players/:uuid?fights=N&category=C -> one player's full stats over their last N
 *                               (25/50/100) fights of PvP category C, or all fights without it (logged in)
 *
 * Stats are only recorded during fights: from GTM's combat tag starting to
 * the player's kill or death. The mod uploads each finished fight in one
 * go, and only each player's last MAX_FIGHTS fights of each PvP category are
 * kept - older ones are deleted as new ones arrive, so a day of Air fights
 * doesn't push out Wing history. Stats are shown over the last 25, 50 or
 * 100 of those.
 *
 * Gun stats come as totals per gun for the fight rather than one row per
 * shot - automatic guns fire many times a second, and per-shot rows would
 * quickly use up D1's daily write allowance.
 *
 * POST /swaps, /guns and /combos are what older mod versions upload to.
 * They answer 200 and store nothing, so those clients drop the data
 * instead of retrying forever.
 */

export interface Env {
	DB: D1Database;
	DEV_UUIDS: string;
	/** Comma-separated UUIDs allowed to delete players' stats data (the mod's Admin mode). */
	ADMIN_UUIDS: string;
	/** Oldest mod version allowed to upload fights, e.g. "1.1.0". Empty = no minimum. */
	MIN_MOD_VERSION?: string;
}

/** Fights kept per player (the most a player's page can show). */
/** Fights kept per player, per PvP category. */
const MAX_FIGHTS = 100;
/** How many of a player's last fights their page can show (?fights=N). */
const FIGHT_VIEWS = [25, 50, 100];
/** The player list, and a player's page by default, are over this many fights. */
const DEFAULT_VIEW = 25;
const MAX_SWAPS_PER_FIGHT = 300;
const MAX_GUNS_PER_FIGHT = 50;
const MAX_SHOTS_PER_FIGHT = 100_000;
/** Movement gun speeds above this (blocks/s) are dropped as bogus. */
const MAX_SPEED_BPS = 500;
const MAX_FIGHT_MS = 6 * 60 * 60 * 1000;

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

// Optional per-swap numbers; anything missing or non-finite is stored as NULL.
const METRICS = [
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

// How the inventory opened (see migration 0017). Stored with every swap but not part of METRICS, so the stats views don't read them.
const INPUT_METRICS = ["cursor_dx", "cursor_dy", "direct_px", "approach_px", "gui_x", "gui_y", "scaled_w", "scaled_h", "gui_scale", "creative", "from_screen"] as const;

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (e) {
			console.error(e);
			return json({ error: "internal error" }, 500);
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
	if (method === "POST" && pathname === "/fights") return uploadFight(request, env);
	if (method === "POST" && (pathname === "/swaps" || pathname === "/guns" || pathname === "/combos")) {
		return ignoreLegacyUpload(request, env);
	}

	const player = pathname.match(/^\/players\/([0-9a-f]{32})$/);
	if (method === "GET" && player) return playerDetail(request, env, player[1]);

	const playerFightList = pathname.match(/^\/players\/([0-9a-f]{32})\/fights$/);
	if (method === "GET" && playerFightList) return playerFights(request, env, playerFightList[1]);

	if (method === "GET" && pathname === "/leaderboard") return leaderboard(request, env);

	// Admin mode: looking a player up, and deleting stats data. All check ADMIN_UUIDS on every request.
	if (method === "GET" && pathname === "/admin/player-info") return adminPlayerInfo(request, env);
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
	return json({ ok: true });
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

	const existing = await env.DB.prepare("SELECT id FROM fights WHERE uuid = ? AND fight_key = ?").bind(uuid, fightKey).first();
	if (existing) return json({ stored: 0, duplicate: true });

	const category = typeof body?.category === "string" && CATEGORIES.has(body.category)
		? body.category
		: guessCategory(swaps, guns);

	// Children find their fight by (uuid, fight_key), so everything can go in one batch.
	const fightId = "(SELECT id FROM fights WHERE uuid = ? AND fight_key = ?)";
	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			"INSERT INTO fights (uuid, fight_key, started_at, ended_at, outcome, opponent, category) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(uuid, fightKey, startedAt, endedAt, outcome, opponent, category),
	];

	const swapColumns = ["uuid", "ts", "result", "category", "swap_type", "total_ms", ...METRICS, ...INPUT_METRICS];
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
		statements.push(insertSwap.bind(uuid, fightKey, uuid, ts, s.result, s.category, swapType, totalMs,
			...METRICS.map((m) => finiteOrNull(s[m])), ...INPUT_METRICS.map((m) => finiteOrNull(s[m]))));
	}

	const insertGun = env.DB.prepare(
		`INSERT INTO fight_guns (fight_id, uuid, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps)
		 VALUES (${fightId}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (fight_id, category, gun) DO UPDATE SET
		   shots = shots + excluded.shots, hits = hits + excluded.hits,
		   headshots = headshots + excluded.headshots, kills = kills + excluded.kills,
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
		statements.push(insertGun.bind(uuid, fightKey, uuid, category, gun, shots, hits, headshots, kills,
			hasSpeed ? speedShots : null, hasSpeed ? speedTotal : null, hasSpeed ? speedBest : null));
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
		statements.push(insertCombo.bind(uuid, fightKey, uuid, category, enemy, enemyBroken, own, ownBroken,
			enemyFirst !== null && enemyFirst <= enemy ? enemyFirst : null,
			ownFirst !== null && ownFirst <= own ? ownFirst : null));
	}

	// Keep only the last MAX_FIGHTS fights of this category (children first, then the fights). Only the
	// fights past the limit are looked at, so this reads ~MAX_FIGHTS index rows (fights_uuid_category_ended)
	// rather than every row the player has.
	const old = `SELECT id FROM fights WHERE uuid = ? AND category = ? ORDER BY ended_at DESC, id DESC LIMIT -1 OFFSET ${MAX_FIGHTS}`;
	for (const table of ["swaps", "fight_guns", "fight_combos"]) {
		statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE fight_id IN (${old})`).bind(uuid, category));
	}
	statements.push(env.DB.prepare(`DELETE FROM fights WHERE id IN (${old})`).bind(uuid, category));
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
// their last 25, 50 or 100 fights of one PvP category
// (?fights=N&category=JP), so each tab is over that kind of fight.

/**
 * The ids of a player's last n fights (of one category, if given), for
 * `fight_id IN (...)`. Binds the uuid. category must already be checked
 * against CATEGORIES - it's written into the SQL.
 */
function lastFights(n: number, category: string | null = null): string {
	const only = category !== null && CATEGORIES.has(category) ? ` AND f.category = '${category}'` : "";
	return `SELECT f.id FROM fights f WHERE f.uuid = ?${only} ORDER BY f.ended_at DESC, f.id DESC LIMIT ${n}`;
}

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
	// Every query below is limited to these fights; each use binds the uuid once more.
	const inView = `fight_id IN (${lastFights(n, category)})`;

	const averages = ["total_ms", ...METRICS].map((m) => `AVG(${m}) AS ${m}`).join(", ");
	const [fights, counts, avg, recent, guns, airSwaps, combos, recentFights, movementGuns] = await env.DB.batch([
		env.DB.prepare(
			`SELECT COUNT(*)                              AS fights,
			        COALESCE(SUM(outcome = 'KILL'), 0)    AS kills,
			        COALESCE(SUM(outcome = 'DEATH'), 0)   AS deaths
			   FROM fights WHERE id IN (${lastFights(n, category)})`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT COUNT(*)                                              AS total,
			        COALESCE(SUM(result = 'SUCCESS'), 0)                  AS successes,
			        COALESCE(SUM(result = 'FAILED'), 0)                   AS failures,
			        COALESCE(SUM(result = 'CANCELED'), 0)                 AS cancels,
			        MIN(CASE WHEN result = 'SUCCESS' THEN total_ms END)   AS best_ms
			   FROM swaps WHERE category = 'WING' AND ${inView}`,
		).bind(uuid),
		// Averages only over successful swaps, so failed/canceled ones don't skew them.
		env.DB.prepare(
			`SELECT ${averages} FROM swaps WHERE category = 'WING' AND result = 'SUCCESS' AND ${inView}`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT ts, result, total_ms, wing_to_hotbar_ms, efficiency, overflick_deg
			   FROM swaps WHERE category = 'WING' AND ${inView} ORDER BY ts DESC LIMIT 15`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT g.category, g.gun, SUM(g.shots) AS shots, SUM(g.hits) AS hits, SUM(g.headshots) AS headshots,
			        SUM(g.kills) AS kills, MAX(f.ended_at) AS last_used
			   FROM fight_guns g JOIN fights f ON f.id = g.fight_id
			  WHERE g.${inView}
			  GROUP BY g.category, g.gun
			  ORDER BY shots DESC LIMIT 80`,
		).bind(uuid),
		// Air PvP swaps per type; failed/canceled attempts have no type and group as null.
		env.DB.prepare(
			`SELECT swap_type,
			        COUNT(*)                                              AS total,
			        COALESCE(SUM(result = 'SUCCESS'), 0)                  AS successes,
			        COALESCE(SUM(result = 'CANCELED'), 0)                 AS cancels,
			        AVG(CASE WHEN result = 'SUCCESS' THEN total_ms END)   AS avg_ms,
			        MIN(CASE WHEN result = 'SUCCESS' THEN total_ms END)   AS best_ms,
			        AVG(CASE WHEN result = 'SUCCESS' AND speed_after_bps IS NOT NULL THEN speed_before_bps END) AS speed_before_bps,
			        AVG(CASE WHEN result = 'SUCCESS' AND speed_before_bps IS NOT NULL THEN speed_after_bps END) AS speed_after_bps,
			        COALESCE(SUM(result = 'SUCCESS' AND speed_before_bps IS NOT NULL AND speed_after_bps IS NOT NULL), 0) AS momentum_swaps
			   FROM swaps WHERE category = 'AIR' AND ${inView}
			  GROUP BY swap_type`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT category, SUM(enemy_combos) AS enemy_combos, SUM(enemy_broken) AS enemy_broken,
			        SUM(own_combos) AS own_combos, SUM(own_broken) AS own_broken,
			        COALESCE(SUM(enemy_first_hits), 0) AS enemy_first_hits,
			        COALESCE(SUM(own_first_hits), 0) AS own_first_hits
			   FROM fight_combos WHERE ${inView}
			  GROUP BY category`,
		).bind(uuid),
		// The last few fights in the view, newest first, for the fights strip.
		env.DB.prepare(
			`SELECT outcome, opponent, started_at, ended_at
			   FROM fights WHERE id IN (${lastFights(n, category)})
			  ORDER BY ended_at DESC, id DESC LIMIT 10`,
		).bind(uuid),
		// Ground PvP movement guns: horizontal speed right after their shots, per gun.
		env.DB.prepare(
			`SELECT gun, SUM(speed_shots) AS shots, SUM(speed_total_bps) / SUM(speed_shots) AS avg_bps,
			        MAX(speed_best_bps) AS best_bps
			   FROM fight_guns WHERE category = 'GROUND' AND speed_shots > 0 AND ${inView}
			  GROUP BY gun ORDER BY shots DESC`,
		).bind(uuid),
	]);

	return json({
		...player,
		...(fights.results[0] as object),
		...(counts.results[0] as object),
		avg: avg.results[0],
		recent: recent.results,
		guns: guns.results,
		air_swaps: airSwaps.results,
		combos: combos.results,
		recent_fights: recentFights.results,
		movement_guns: movementGuns.results,
	});
}

/** Most swap rows sent with one player's fight list (newest first), so a huge history can't make an enormous reply. */
const MAX_SWAPS_IN_FIGHT_LIST = 5000;

/**
 * One player's last MAX_FIGHTS fights of each category, newest first, each with its own swaps,
 * gun totals and combo totals - the raw material for the fight log, per-fight
 * ratings and custom filters (fight count, opponents), which the mod works out
 * itself. Only Wing and Air swaps are sent (the only ones ever shown). Numbers
 * are rounded to keep the reply small.
 */
async function playerFights(request: Request, env: Env, uuid: string): Promise<Response> {
	if (!(await authenticate(request, env))) return json({ error: "not logged in" }, 401);
	const player = await env.DB.prepare("SELECT uuid, name, first_seen, last_seen FROM players WHERE uuid = ?")
		.bind(uuid)
		.first();
	if (!player) return json({ error: "no such player" }, 404);

	const kept = `SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY category ORDER BY ended_at DESC, id DESC) AS rn
		FROM fights WHERE uuid = ?) WHERE rn <= ${MAX_FIGHTS}`;
	const [fights, swaps, guns, combos] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, fight_key, started_at, ended_at, outcome, opponent, category
			   FROM fights WHERE id IN (${kept}) ORDER BY ended_at DESC, id DESC`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT fight_id, ts, result, category, swap_type, total_ms, ${METRICS.join(", ")}
			   FROM swaps WHERE category IN ('WING', 'AIR') AND fight_id IN (${kept})
			  ORDER BY ts DESC LIMIT ${MAX_SWAPS_IN_FIGHT_LIST}`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT fight_id, category, gun, shots, hits, headshots, kills, speed_shots, speed_total_bps, speed_best_bps
			   FROM fight_guns WHERE fight_id IN (${kept})`,
		).bind(uuid),
		env.DB.prepare(
			`SELECT fight_id, category, enemy_combos, enemy_broken, own_combos, own_broken,
			        enemy_first_hits, own_first_hits
			   FROM fight_combos WHERE fight_id IN (${kept})`,
		).bind(uuid),
	]);

	// Group the children under their fight, dropping the fight id and tidying numbers.
	const byFight = (rows: Record<string, unknown>[]) => {
		const groups = new Map<number, Record<string, unknown>[]>();
		for (const row of rows) {
			const { fight_id, ...rest } = row;
			const id = fight_id as number;
			if (!groups.has(id)) groups.set(id, []);
			groups.get(id)!.push(roundNumbers(rest));
		}
		return groups;
	};
	const swapsByFight = byFight(swaps.results as Record<string, unknown>[]);
	const gunsByFight = byFight(guns.results as Record<string, unknown>[]);
	const combosByFight = byFight(combos.results as Record<string, unknown>[]);

	return json({
		...player,
		fights: (fights.results as Record<string, unknown>[]).map((f) => {
			const { id, ...rest } = f;
			return {
				...rest,
				swaps: swapsByFight.get(id as number) ?? [],
				guns: gunsByFight.get(id as number) ?? [],
				combos: combosByFight.get(id as number) ?? [],
			};
		}),
	});
}

/** Rounds every non-integer number in a row to 2 decimals (times, degrees, speeds). */
function roundNumbers(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		out[key] = typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value;
	}
	return out;
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
 * Each player is measured over their newest `fights` (1-100) fights of that
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

	// Every view is stored in D1 for LEADERBOARD_TTL_S (the Cache API does nothing on workers.dev),
	// so each view's ranking queries run at most once per period, for everyone.
	const key = `${category}|${n}|${opponents.join(",")}`;
	const stored = await readStoredView(env, key);
	if (stored) return new Response(stored, { headers: { "Content-Type": "application/json" } });
	// Plain 25 / 50 / 100 views are put together from each player's stored row (rebuilding only the players whose
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
	await storeView(env, key, body);
	return new Response(body, { headers: { "Content-Type": "application/json" } });
}

/** The ranking queries for one leaderboard view, as the JSON the mod reads. */
export async function computeLeaderboard(env: Env, category: string, n: number, opponents: string[]): Promise<string> {
	// category, n and the names are validated above, so they're safe to write into the SQL.
	const opponentClause = opponents.length ? ` AND lower(opponent) IN (${opponents.map((o) => `'${o}'`).join(", ")})` : "";
	const picked =
		`WITH ranked AS (SELECT id, uuid, outcome, ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY ended_at DESC, id DESC) AS rn ` +
		`FROM fights WHERE category = '${category}'${opponentClause}), ` +
		`picked AS (SELECT id, uuid, outcome FROM ranked WHERE rn <= ${n}) `;

	// Each query is labelled so its rows can be found again below.
	const labels = ["people", "guns", "opponents"];
	const statements = [
		env.DB.prepare(
			`${picked} SELECT p.uuid, pl.name, pl.first_seen, pl.last_seen, COUNT(*) AS fights,
			        COALESCE(SUM(p.outcome = 'KILL'), 0) AS kills, COALESCE(SUM(p.outcome = 'DEATH'), 0) AS deaths
			   FROM picked p JOIN players pl ON pl.uuid = p.uuid GROUP BY p.uuid`,
		),
		env.DB.prepare(
			`${picked} SELECT g.uuid, g.category, g.gun, SUM(g.shots) AS shots, SUM(g.hits) AS hits,
			        SUM(g.headshots) AS headshots, SUM(g.kills) AS kills
			   FROM fight_guns g JOIN picked p ON p.id = g.fight_id WHERE g.category = '${category}'
			  GROUP BY g.uuid, g.category, g.gun`,
		),
		env.DB.prepare(
			`WITH ranked AS (SELECT opponent, ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY ended_at DESC, id DESC) AS rn
			                   FROM fights WHERE category = '${category}')
			 SELECT lower(opponent) AS key, MAX(opponent) AS name, COUNT(*) AS fights
			   FROM ranked WHERE rn <= ${n} AND opponent IS NOT NULL
			  GROUP BY lower(opponent) ORDER BY fights DESC, key LIMIT ${MAX_OPPONENTS_LISTED}`,
		),
	];
	// Only what this category's ratings read.
	if (category === "WING") {
		labels.push("wing_swaps");
		statements.push(env.DB.prepare(
			`${picked} SELECT s.uuid, COUNT(*) AS total,
			        COALESCE(SUM(s.result = 'SUCCESS'), 0) AS successes, COALESCE(SUM(s.result = 'FAILED'), 0) AS failures,
			        COALESCE(SUM(s.result = 'CANCELED'), 0) AS cancels,
			        MIN(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS best_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS total_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.speed_before_bps END) AS speed_before_bps,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.speed_after_bps END) AS speed_after_bps
			   FROM swaps s JOIN picked p ON p.id = s.fight_id WHERE s.category = 'WING' GROUP BY s.uuid`,
		));
	} else if (category === "AIR") {
		labels.push("air_swaps");
		statements.push(env.DB.prepare(
			`${picked} SELECT s.uuid, s.swap_type, COUNT(*) AS total,
			        COALESCE(SUM(s.result = 'SUCCESS'), 0) AS successes, COALESCE(SUM(s.result = 'CANCELED'), 0) AS cancels,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS avg_ms,
			        MIN(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS best_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' AND s.speed_after_bps IS NOT NULL THEN s.speed_before_bps END) AS speed_before_bps,
			        AVG(CASE WHEN s.result = 'SUCCESS' AND s.speed_before_bps IS NOT NULL THEN s.speed_after_bps END) AS speed_after_bps,
			        COALESCE(SUM(s.result = 'SUCCESS' AND s.speed_before_bps IS NOT NULL AND s.speed_after_bps IS NOT NULL), 0) AS momentum_swaps
			   FROM swaps s JOIN picked p ON p.id = s.fight_id WHERE s.category = 'AIR' GROUP BY s.uuid, s.swap_type`,
		));
	} else if (category === "GROUND") {
		labels.push("movement_guns");
		statements.push(env.DB.prepare(
			`${picked} SELECT g.uuid, g.gun, SUM(g.speed_shots) AS shots, SUM(g.speed_total_bps) / SUM(g.speed_shots) AS avg_bps,
			        MAX(g.speed_best_bps) AS best_bps
			   FROM fight_guns g JOIN picked p ON p.id = g.fight_id
			  WHERE g.category = 'GROUND' AND g.speed_shots > 0 GROUP BY g.uuid, g.gun`,
		));
	}
	if (category === "JP" || category === "AIR") {
		labels.push("combos");
		statements.push(env.DB.prepare(
			`${picked} SELECT c.uuid, c.category, SUM(c.enemy_combos) AS enemy_combos, SUM(c.enemy_broken) AS enemy_broken,
			        SUM(c.own_combos) AS own_combos, SUM(c.own_broken) AS own_broken,
			        COALESCE(SUM(c.enemy_first_hits), 0) AS enemy_first_hits,
			        COALESCE(SUM(c.own_first_hits), 0) AS own_first_hits
			   FROM fight_combos c JOIN picked p ON p.id = c.fight_id WHERE c.category = '${category}' GROUP BY c.uuid, c.category`,
		));
	}
	const results = await env.DB.batch(statements);
	const rowsOf = (label: string) => (results[labels.indexOf(label)]?.results ?? []) as Record<string, unknown>[];

	const byPlayer = new Map<string, Record<string, unknown>>();
	for (const row of rowsOf("people")) {
		byPlayer.set(row.uuid as string, {
			...row, total: 0, successes: 0, failures: 0, cancels: 0, guns: [], air_swaps: [], combos: [], movement_guns: [],
		});
	}
	/** Adds each row (minus its uuid) to a list on its player. */
	const addTo = (label: string, list: "guns" | "air_swaps" | "combos" | "movement_guns") => {
		for (const row of rowsOf(label)) {
			const { uuid, ...rest } = row;
			(byPlayer.get(uuid as string)?.[list] as unknown[] | undefined)?.push(roundNumbers(rest));
		}
	};
	addTo("guns", "guns");
	addTo("air_swaps", "air_swaps");
	addTo("movement_guns", "movement_guns");
	addTo("combos", "combos");
	for (const row of rowsOf("wing_swaps")) {
		const { uuid, total_ms, speed_before_bps, speed_after_bps, ...counts } = row;
		const p = byPlayer.get(uuid as string);
		if (p) Object.assign(p, roundNumbers(counts), { avg: roundNumbers({ total_ms, speed_before_bps, speed_after_bps }) });
	}

	const body = JSON.stringify({
		category,
		fights: n,
		players: [...byPlayer.values()].map(roundNumbers),
		opponents: rowsOf("opponents").map((r) => ({ key: r.key, name: r.name, fights: r.fights })),
	});
	return body;
}

// ---- Leaderboard rows per player ----

/** The view sizes whose per-player rows are kept (leaderboard_rows, migration 0015). */
const ROW_WINDOWS = [25, 50, 100];
/** Most players rebuilt in one request: each costs two database calls, and one request may make only a few dozen. */
const MAX_REBUILDS_PER_REQUEST = 10;

/** Marks a player's rows for one category as out of date (their fights there changed). */
function dirtyStatement(env: Env, uuid: string, category: string): D1PreparedStatement {
	return env.DB.prepare("INSERT OR REPLACE INTO leaderboard_dirty (uuid, category, marked_at) VALUES (?, ?, ?)").bind(uuid, category, Date.now());
}

/** One player's newest n fights of a category. category is already checked against CATEGORIES; binds the uuid. */
function pickedForPlayer(category: string, n: number): string {
	return `WITH ranked AS (SELECT id, uuid, outcome, ROW_NUMBER() OVER (ORDER BY ended_at DESC, id DESC) AS rn ` +
		`FROM fights WHERE category = '${category}' AND uuid = ?), ` +
		`picked AS (SELECT id, uuid, outcome FROM ranked WHERE rn <= ${n}) `;
}

/** The same numbers computeLeaderboard works out for everyone, for one player and one view size. */
function playerWindowStatements(env: Env, uuid: string, category: string, n: number): { labels: string[]; statements: D1PreparedStatement[] } {
	const picked = pickedForPlayer(category, n);
	const labels = ["people", "guns", "opponents"];
	const statements = [
		env.DB.prepare(
			`${picked} SELECT COUNT(*) AS fights, COALESCE(SUM(outcome = 'KILL'), 0) AS kills, COALESCE(SUM(outcome = 'DEATH'), 0) AS deaths FROM picked`,
		).bind(uuid),
		env.DB.prepare(
			`${picked} SELECT g.uuid, g.category, g.gun, SUM(g.shots) AS shots, SUM(g.hits) AS hits,
			        SUM(g.headshots) AS headshots, SUM(g.kills) AS kills
			   FROM fight_guns g JOIN picked p ON p.id = g.fight_id WHERE g.category = '${category}'
			  GROUP BY g.uuid, g.category, g.gun`,
		).bind(uuid),
		env.DB.prepare(
			`WITH ranked AS (SELECT opponent, ROW_NUMBER() OVER (ORDER BY ended_at DESC, id DESC) AS rn
			                   FROM fights WHERE category = '${category}' AND uuid = ?)
			 SELECT lower(opponent) AS key, MAX(opponent) AS name, COUNT(*) AS fights
			   FROM ranked WHERE rn <= ${n} AND opponent IS NOT NULL GROUP BY lower(opponent)`,
		).bind(uuid),
	];
	if (category === "WING") {
		labels.push("wing_swaps");
		statements.push(env.DB.prepare(
			`${picked} SELECT s.uuid, COUNT(*) AS total,
			        COALESCE(SUM(s.result = 'SUCCESS'), 0) AS successes, COALESCE(SUM(s.result = 'FAILED'), 0) AS failures,
			        COALESCE(SUM(s.result = 'CANCELED'), 0) AS cancels,
			        MIN(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS best_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS total_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.speed_before_bps END) AS speed_before_bps,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.speed_after_bps END) AS speed_after_bps
			   FROM swaps s JOIN picked p ON p.id = s.fight_id WHERE s.category = 'WING' GROUP BY s.uuid`,
		).bind(uuid));
	} else if (category === "AIR") {
		labels.push("air_swaps");
		statements.push(env.DB.prepare(
			`${picked} SELECT s.uuid, s.swap_type, COUNT(*) AS total,
			        COALESCE(SUM(s.result = 'SUCCESS'), 0) AS successes, COALESCE(SUM(s.result = 'CANCELED'), 0) AS cancels,
			        AVG(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS avg_ms,
			        MIN(CASE WHEN s.result = 'SUCCESS' THEN s.total_ms END) AS best_ms,
			        AVG(CASE WHEN s.result = 'SUCCESS' AND s.speed_after_bps IS NOT NULL THEN s.speed_before_bps END) AS speed_before_bps,
			        AVG(CASE WHEN s.result = 'SUCCESS' AND s.speed_before_bps IS NOT NULL THEN s.speed_after_bps END) AS speed_after_bps,
			        COALESCE(SUM(s.result = 'SUCCESS' AND s.speed_before_bps IS NOT NULL AND s.speed_after_bps IS NOT NULL), 0) AS momentum_swaps
			   FROM swaps s JOIN picked p ON p.id = s.fight_id WHERE s.category = 'AIR' GROUP BY s.uuid, s.swap_type`,
		).bind(uuid));
	} else if (category === "GROUND") {
		labels.push("movement_guns");
		statements.push(env.DB.prepare(
			`${picked} SELECT g.uuid, g.gun, SUM(g.speed_shots) AS shots, SUM(g.speed_total_bps) / SUM(g.speed_shots) AS avg_bps,
			        MAX(g.speed_best_bps) AS best_bps
			   FROM fight_guns g JOIN picked p ON p.id = g.fight_id
			  WHERE g.category = 'GROUND' AND g.speed_shots > 0 GROUP BY g.uuid, g.gun`,
		).bind(uuid));
	}
	if (category === "JP" || category === "AIR") {
		labels.push("combos");
		statements.push(env.DB.prepare(
			`${picked} SELECT c.uuid, c.category, SUM(c.enemy_combos) AS enemy_combos, SUM(c.enemy_broken) AS enemy_broken,
			        SUM(c.own_combos) AS own_combos, SUM(c.own_broken) AS own_broken,
			        COALESCE(SUM(c.enemy_first_hits), 0) AS enemy_first_hits,
			        COALESCE(SUM(c.own_first_hits), 0) AS own_first_hits
			   FROM fight_combos c JOIN picked p ON p.id = c.fight_id WHERE c.category = '${category}' GROUP BY c.uuid, c.category`,
		).bind(uuid));
	}
	return { labels, statements };
}

/**
 * The player's entry as computeLeaderboard builds it, without what changes on its own (name, first and last seen: those
 * are read fresh when a view is put together), plus _opp, the opponents counted in the window. Null with no fights.
 */
function assemblePlayerRow(rowsOf: (label: string) => Record<string, unknown>[]): Record<string, unknown> | null {
	const people = rowsOf("people")[0];
	if (!people || !(people.fights as number)) return null;
	const row: Record<string, unknown> = {
		fights: people.fights, kills: people.kills, deaths: people.deaths,
		total: 0, successes: 0, failures: 0, cancels: 0, guns: [], air_swaps: [], combos: [], movement_guns: [],
	};
	const addTo = (label: string, list: "guns" | "air_swaps" | "combos" | "movement_guns") => {
		for (const r of rowsOf(label)) {
			const { uuid, ...rest } = r;
			(row[list] as unknown[]).push(roundNumbers(rest));
		}
	};
	addTo("guns", "guns");
	addTo("air_swaps", "air_swaps");
	addTo("movement_guns", "movement_guns");
	addTo("combos", "combos");
	for (const r of rowsOf("wing_swaps")) {
		const { uuid, total_ms, speed_before_bps, speed_after_bps, ...counts } = r;
		Object.assign(row, roundNumbers(counts), { avg: roundNumbers({ total_ms, speed_before_bps, speed_after_bps }) });
	}
	row._opp = rowsOf("opponents").map((r) => [r.key, r.name, r.fights]);
	return row;
}

/** Works out one player's rows (all view sizes) for a category and stores them; clears their dirty mark if it has not been re-marked since. */
async function rebuildPlayerRows(env: Env, uuid: string, category: string, markedAt: number): Promise<void> {
	const plan: { n: number; labels: string[]; from: number }[] = [];
	const statements: D1PreparedStatement[] = [];
	for (const n of ROW_WINDOWS) {
		const window = playerWindowStatements(env, uuid, category, n);
		plan.push({ n, labels: window.labels, from: statements.length });
		statements.push(...window.statements);
	}
	const results = await env.DB.batch(statements);
	const now = Date.now();
	const writes: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM leaderboard_rows WHERE uuid = ? AND category = ?").bind(uuid, category)];
	for (const { n, labels, from } of plan) {
		const row = assemblePlayerRow((label) => {
			const at = labels.indexOf(label);
			return at < 0 ? [] : ((results[from + at]?.results ?? []) as Record<string, unknown>[]);
		});
		if (row) {
			writes.push(env.DB.prepare("INSERT INTO leaderboard_rows (uuid, category, n, row, built_at) VALUES (?, ?, ?, ?, ?)")
				.bind(uuid, category, n, JSON.stringify(row), now));
		}
	}
	// Only if no fight was uploaded meanwhile (it would have set a newer mark).
	writes.push(env.DB.prepare("DELETE FROM leaderboard_dirty WHERE uuid = ? AND category = ? AND marked_at <= ?").bind(uuid, category, markedAt));
	await env.DB.batch(writes);
}

/**
 * A plain leaderboard view from the stored per-player rows: first rebuilds the (few) players whose fights changed, then
 * reads one row each. Returns null when the rows cannot be complete yet (players still waiting for their first build),
 * so the caller computes the view in full.
 */
export async function computeLeaderboardFromRows(env: Env, category: string, n: number): Promise<string | null> {
	const dirty = await env.DB.prepare("SELECT uuid, marked_at FROM leaderboard_dirty WHERE category = ? ORDER BY marked_at LIMIT ?")
		.bind(category, MAX_REBUILDS_PER_REQUEST)
		.all<{ uuid: string; marked_at: number }>();
	for (const d of dirty.results) await rebuildPlayerRows(env, d.uuid, category, d.marked_at);

	const unbuilt = await env.DB.prepare(
		`SELECT 1 AS x FROM leaderboard_dirty d WHERE d.category = ?
		   AND NOT EXISTS (SELECT 1 FROM leaderboard_rows r WHERE r.uuid = d.uuid AND r.category = d.category AND r.n = ?) LIMIT 1`,
	).bind(category, n).first();
	if (unbuilt) return null;

	const { results } = await env.DB.prepare(
		`SELECT r.uuid, r.row, p.name, p.first_seen, p.last_seen
		   FROM leaderboard_rows r JOIN players p ON p.uuid = r.uuid
		  WHERE r.category = ? AND r.n = ? ORDER BY r.uuid`,
	).bind(category, n).all<{ uuid: string; row: string; name: string; first_seen: number; last_seen: number }>();

	const opponents = new Map<string, { name: string; fights: number }>();
	const players = results.map((r) => {
		const row = JSON.parse(r.row) as Record<string, unknown>;
		for (const [key, name, count] of (row._opp ?? []) as [string, string, number][]) {
			const seen = opponents.get(key);
			if (!seen) opponents.set(key, { name, fights: count });
			else {
				seen.fights += count;
				if (name > seen.name) seen.name = name;
			}
		}
		delete row._opp;
		return roundNumbers({ uuid: r.uuid, name: r.name, first_seen: r.first_seen, last_seen: r.last_seen, ...row });
	});
	return JSON.stringify({
		category,
		fights: n,
		players,
		opponents: [...opponents.entries()]
			.map(([key, v]) => ({ key, name: v.name, fights: v.fights }))
			.sort((a, b) => b.fights - a.fights || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
			.slice(0, MAX_OPPONENTS_LISTED),
	});
}

export async function readStoredView(env: Env, key: string): Promise<string | null> {
	try {
		const row = await env.DB.prepare("SELECT body FROM leaderboard_views WHERE key = ? AND computed_at > ?")
			.bind(key, Date.now() - LEADERBOARD_TTL_S * 1000)
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
		if (s.n >= 10 && s.under_fast >= 2) {
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
	return json({
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
	});
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
	]);
	if (fight.category) {
		try {
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
