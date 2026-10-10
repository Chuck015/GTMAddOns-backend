# SwapInfo stats backend

A Cloudflare Worker + D1 database that stores every GTMAddOns player's fight stats
(swaps, guns and melee combos). Stats are only recorded per fight - from
GTM's combat tag starting to the player's kill or death - and only each
player's last 500 fights of each PvP category are kept. The player list is over each player's
last 25; a player's page can show their last 25, 50, 100, 250 or 500.
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
- **Row budget:** D1's free plan allows 5 million rows read a day, so no view
  reads a whole history. Each fight stores its own totals (`fights.summary`,
  `src/summary.ts`), leaderboards are built from one stored row per player, the
  mod keeps the fights it has read and asks only for newer ones
  (`/players/:uuid/fights?since=`), and every request's rows are counted per route
  and day in `usage_daily` (`src/usage.ts`). After adding the `summary` column to
  an existing database, run `node scripts/backfill-summaries.mjs --remote` once.
