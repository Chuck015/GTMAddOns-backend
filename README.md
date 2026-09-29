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


