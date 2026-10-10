/**
 * Row budget.
 *
 * D1's free plan allows 5 million rows read (and 100 000 written) per day, for the whole account; past that every query
 * fails until midnight UTC. So every database call a request makes is counted here from the numbers D1 reports
 * (meta.rows_read / rows_written), and added up per route and day in usage_daily (migration 0023):
 *
 *   SELECT * FROM usage_daily WHERE day = '2026-10-10' ORDER BY rows_read DESC;   -- route '*' is the day's total
 *
 * Counts are gathered in memory and written in one go every so often (a write per request would itself use the write
 * allowance), so a little is lost when Cloudflare retires a worker instance: the table slightly undercounts.
 *
 * Past TIGHT_ROWS_READ in a day, tightBudget() turns true and the stored views (leaderboards, raw info, flagged players)
 * are served however old they are instead of being worked out again, so uploads keep working to the end of the day.
 */

export interface Used { read: number; written: number }

/** 80% of the free plan's 5 million rows read per day. */
const TIGHT_ROWS_READ = 4_000_000;
/** Write the gathered counts once this much has built up, or this long has passed. */
const FLUSH_ROWS = 2000;
const FLUSH_REQUESTS = 40;
const FLUSH_MS = 60_000;

class CountedStatement {
	constructor(readonly inner: D1PreparedStatement, private readonly used: Used) {}

	bind(...values: unknown[]): CountedStatement {
		return new CountedStatement(this.inner.bind(...values), this.used);
	}

	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const result = await this.inner.all<Record<string, unknown>>();
		note(this.used, result);
		const row = result.results[0] ?? null;
		if (column === undefined) return row as T | null;
		return row === null ? null : ((row[column] ?? null) as T | null);
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const result = await this.inner.all<T>();
		note(this.used, result);
		return result;
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const result = await this.inner.run<T>();
		note(this.used, result);
		return result;
	}
}

function note(used: Used, result: { meta?: { rows_read?: number; rows_written?: number } }): void {
	used.read += result.meta?.rows_read ?? 0;
	used.written += result.meta?.rows_written ?? 0;
}

/** The database, with every prepare / batch counted into `used`. Only what the worker uses is wrapped (prepare, bind, first, all, run, batch). */
export function countingDatabase(db: D1Database): { db: D1Database; used: Used } {
	const used: Used = { read: 0, written: 0 };
	const counted = {
		prepare: (query: string) => new CountedStatement(db.prepare(query), used),
		batch: async (statements: unknown[]) => {
			const results = await db.batch(statements.map((s) => (s instanceof CountedStatement ? s.inner : (s as D1PreparedStatement))));
			for (const result of results) note(used, result);
			return results;
		},
	};
	return { db: counted as unknown as D1Database, used };
}

/** The route a request counts under: the method and the path with ids taken out. */
export function routeLabel(request: Request): string {
	const url = new URL(request.url);
	let path = url.pathname.replace(/[0-9a-f]{32}/g, ":id");
	if (path.length > 60) path = path.slice(0, 60);
	if (path === "/players/:id/fights" && url.searchParams.has("since")) path += "?since";
	if (path === "/leaderboard" && (url.searchParams.get("opponents") ?? "") !== "") path += "?opponents";
	return `${request.method} ${path}`;
}

const pending = new Map<string, { requests: number; read: number; written: number }>();
let pendingRows = 0, pendingRequests = 0, lastFlush = Date.now();
let knownDay = "", knownRead = 0;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/** True once today's rows read (as far as this instance knows) are past the tight line. */
export function tightBudget(): boolean {
	return knownDay === today() && knownRead >= TIGHT_ROWS_READ;
}

/** Adds one request's counts; now and then writes what has gathered to usage_daily. Never throws. */
export async function recordUsage(db: D1Database, label: string, used: Used): Promise<void> {
	const entry = pending.get(label) ?? { requests: 0, read: 0, written: 0 };
	entry.requests++;
	entry.read += used.read;
	entry.written += used.written;
	pending.set(label, entry);
	pendingRows += used.read + used.written;
	pendingRequests++;

	const now = Date.now();
	if (pendingRows < FLUSH_ROWS && pendingRequests < FLUSH_REQUESTS && now - lastFlush < FLUSH_MS) return;
	const batch = [...pending.entries()];
	pending.clear();
	pendingRows = 0;
	pendingRequests = 0;
	lastFlush = now;

	const day = today();
	const upsert = db.prepare(
		`INSERT INTO usage_daily (day, route, requests, rows_read, rows_written) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (day, route) DO UPDATE SET requests = requests + excluded.requests,
		   rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written
		 RETURNING rows_read`,
	);
	let requests = 0, read = 0, written = 0;
	for (const [, e] of batch) {
		requests += e.requests;
		read += e.read;
		written += e.written;
	}
	try {
		const results = await db.batch<{ rows_read: number }>([
			...batch.map(([route, e]) => upsert.bind(day, route, e.requests, e.read, e.written)),
			upsert.bind(day, "*", requests, read, written),
		]);
		knownDay = day;
		knownRead = results[results.length - 1]?.results?.[0]?.rows_read ?? knownRead;
		// What this write itself cost goes into the next one.
		const own = { requests: 0, read: 0, written: 0 };
		for (const result of results) {
			own.read += result.meta?.rows_read ?? 0;
			own.written += result.meta?.rows_written ?? 0;
		}
		const kept = pending.get("usage") ?? { requests: 0, read: 0, written: 0 };
		pending.set("usage", { requests: kept.requests + 1, read: kept.read + own.read, written: kept.written + own.written });
	} catch {
		// usage_daily not created yet: nothing is counted
	}
}
