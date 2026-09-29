# SwapInfo stats backend

A Cloudflare Worker + D1 database that stores every GTMAddOns player's fight stats
(swaps, guns and melee combos). Stats are only recorded per fight - from
GTM's combat tag starting to the player's kill or death - and only each
player's last 100 fights are kept. The player list is over each player's
last 25; a player's page can show their last 25, 50 or 100.
The mod uploads to it, and the Player Stats / Personal Stats menus read from it.

- **Player identity:** the mod signs a one-time challenge with the
  player's Mojang-issued profile key, the key Minecraft signs chat
  with. The backend checks that signature and Mojang's certificate for
  the key, so players can't upload stats as someone else. It doesn't
  use Mojang's session server, because that server blocks requests
  from Cloudflare.
- **Who can view stats:** any player logged in through the mod can see
  everyone's stats.
- **Admin mode:** only UUIDs in `ADMIN_UUIDS` in `wrangler.toml` can use the
  `/admin/...` routes (the mod's Admin mode deletes players' stats data with them).
  It is checked on every request, and each delete is logged as a JSON line in the
  Worker's log. Deletes cannot be undone. After editing the list, run
  `npx wrangler deploy`.
- **Dev mode:** only UUIDs in `DEV_UUIDS` in `wrangler.toml` can turn
  on dev mode (Settings in the `/gao` menu). After editing the list, run `npx wrangler deploy`.
- **Gun stats** are stored as totals per gun per fight
  (`fight_guns` table), not one row per shot. Automatic guns fire too
  fast for per-shot rows to fit in D1's free daily write limit.

Live at `https://swapinfo-backend.swapinfo-backend.workers.dev`.

## Deploying (one time)

You need Node.js and a free Cloudflare account.

Start by copying `wrangler.example.toml` to `wrangler.toml`. The real
`wrangler.toml` is not committed to git: it holds your database id and the
account ids allowed to use dev and admin mode.

```
cd swapinfo-backend
npm install
npx wrangler login
npx wrangler d1 create swapinfo
```

1. Copy the `database_id` that the last command prints into
   `wrangler.toml`.
2. Create the tables:
   ```
   npx wrangler d1 execute swapinfo --remote --file=schema.sql
   ```
3. Deploy:
   ```
   npx wrangler deploy
   ```
   This prints your URL, like `https://swapinfo-backend.<you>.workers.dev`.
4. Put that URL in `BACKEND_URL` in
   `swapinfo/src/main/java/com/example/gtmaddons/stats/StatsClient.java`
   and rebuild the mod. Until you do this, the mod doesn't upload anything.

After changing `src/index.ts`, run `npx wrangler deploy` again.

## Migrations

For an existing database, apply new files in `migrations/` in order, e.g.

```
npx wrangler d1 execute swapinfo --remote --file=migrations/0004_fights.sql
```

`0004_fights.sql` switches to per-fight stats and **deletes all existing
swap, gun and combo stats** (players and logins are kept). Apply it, then
deploy.

`0005_momentum.sql` adds the momentum columns (nothing is deleted).

`0006_fight_category.sql` records which PvP category each fight was, filling
it in for older fights from their own data (nothing is deleted).

`0007_movement_speed.sql` adds the movement gun speed columns, and
`0008_first_hits.sql` adds the first-hit columns to `fight_combos` (nothing is
deleted by either).

**The live database has 0001-0007 applied but not 0008** (checked 2026-09-29).
The worker copes: it checks whether the first-hit columns exist and, if they
don't, skips first hits (uploads, Personal Stats, the leaderboard and the fight
log all still work; first hits read as 0). Applying 0008 later needs no
redeploy - the worker notices within a few minutes.

If `--file` fails with "Authentication error [code: 10000]", run the
statements with `--command "..."` instead. That uses a different API.

## Routes

| Route | Who | What |
|---|---|---|
| `POST /auth/challenge` | anyone | one-time challenge to sign |
| `POST /auth/login` | anyone | exchanges a signed challenge for a 7-day token |
| `GET /me` | logged in | who you are, and whether you have dev access (`dev`) and admin access (`admin`) |
| `POST /fights` | logged in | stores one finished fight (swaps, gun totals, combo totals) for the caller's own account, then deletes anything older than their last 100 fights |
| `POST /swaps`, `/guns`, `/combos` | logged in | old mod versions upload here; answers 200 and stores nothing |
| `GET /leaderboard?category=C&fights=N&opponents=a,b` | logged in | everyone with fights in PvP category C over their newest N (1-100, default 25) fights of it, only against the named opponents if given. Each player comes back shaped like `/players/:uuid` with just what that PvP's ratings need; the mod ranks them. Cached for 60 s per parameter set |
| `DELETE /admin/players/:uuid` | admin | deletes all of a player's fights, swaps, gun and combo totals (the player and login stay) |
| `DELETE /admin/players/:uuid/fights/:fight_key` | admin | deletes one fight and its swaps, gun and combo totals |
| `GET /players` | logged in | every player with totals over their last 25 fights |
| `GET /players/:uuid/fights` | logged in | one player's last 100 fights, raw, newest first: each with its outcome, opponent, PvP category, Wing and Air swaps, gun totals and combo totals. The mod builds the fight log, per-fight ratings and custom filters (how many fights, which opponents) from it. Read-only; no database change |
| `GET /players/:uuid?fights=N&category=C` | logged in | one player's fights, K/D, averages and recent swaps over their last N fights (25, 50 or 100; default 25) of PvP category C (all fights if left out) |

## Limits to know about

- **Stats are self-reported.** The backend knows *who* sent them, but a
  modified client could send made-up numbers. Treat them as coaching
  data, not proof.
- **Usernames aren't verified.** Mojang's certificate covers the UUID,
  not the name, so the name shown is whatever the player's game
  reports. Stats ownership goes by UUID.
- **Mojang's keys are built in.** The certificate keys in
  `MOJANG_CERTIFICATE_KEYS` come from
  https://api.minecraftservices.com/publickeys. If Mojang rotates them,
  logins fail with "isn't signed by Mojang". Paste in the new
  `playerCertificateKeys` and redeploy.
- **Switching accounts in-game:** if a launcher switches accounts
  without refreshing the game's profile key, logging in as the new
  account fails until the game restarts.
- **No rate limiting** beyond Cloudflare's defaults. If someone abuses
  it, add a
  [rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/)
  in the Cloudflare dashboard.
- The free D1 tier (5 GB) holds many millions of swaps.

## License

Copyright (C) 2026 Chuck015. This server is free software, licensed under the
GNU Affero General Public License v3.0 (see `LICENSE`): you may use, modify
and share it, and if you run a modified version as a service that others use
over a network, you must offer them its source under the same license. It
comes with no warranty.
