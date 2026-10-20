# Pricewatch

A small dashboard that tracks the best online price for products you care about.
Add a product, optionally set a target price, and Pricewatch re-checks the stores
on a schedule, keeps the price history, and shows the cheapest current offer, the
change since the last check, and a price chart.

No dependencies; needs Node 20.12+.

```sh
npm start          # http://127.0.0.1:3000
npm test
```

## Run it on your Mac

This keeps it running in the background, starts it at login and restarts it if it crashes.

```sh
brew install node                      # if you don't have Node 20.12+
git clone https://github.com/alicetin1905-ux/Pricewatch
cd Pricewatch
git checkout claude/pricewatch-dashboard   # until this branch is merged into master
./scripts/install-mac.sh
```

Open http://127.0.0.1:3000. The installer creates a `.env` file; put your `SERPAPI_KEY` in
it for real prices (demo prices until then) and apply it with
`launchctl kickstart -k gui/$(id -u)/com.pricewatch`.

- Logs: `~/Library/Logs/Pricewatch/pricewatch.log`
- Your data: `data/db.json` in the project folder
- Update: `git pull`, then the `launchctl kickstart` command above
- Remove: `./scripts/uninstall-mac.sh` (keeps `data/`)

**Sleep:** a sleeping Mac checks nothing. Checks are caught up when it wakes (within
5 minutes), so gaps in the history are fine, but for steady checks leave the Mac on power
and enable *System Settings → Battery/Energy → Prevent automatic sleeping when the display
is off*.

**Opening it from your phone or another computer.** By default it only listens on the Mac
itself. To reach it from other devices, put `HOST=0.0.0.0` and `AUTH_PASSWORD=...` in `.env`
(it refuses to start on the network without a password), then browse to
`http://<mac-name>.local:3000`. The password is sent unencrypted over plain HTTP, so that's
fine at home but not over the internet. For access from anywhere, keep `HOST` as it is and
use [Tailscale](https://tailscale.com) (`tailscale serve 3000` gives you HTTPS inside your
own private network) instead of opening a port on your router.

## Price sources

| Source | When | Notes |
|---|---|---|
| `demo` | default, no key | Simulated prices so you can try the dashboard. A banner says so. |
| `serpapi` | `SERPAPI_KEY` is set | Real prices via [SerpAPI](https://serpapi.com): Google Shopping, the Amazon marketplaces and bol.com below. |

```sh
SERPAPI_KEY=your-key npm start
```

### Amazon marketplaces

With a key, Amazon.com.be, Amazon.nl and Amazon.de are searched too, and the product
page gets an **Amazon & bol.com** chart comparing them over time. Change the
list with `AMAZON_DOMAINS` (any [SerpAPI Amazon domain](https://serpapi.com/amazon-domains),
comma separated; empty disables it). Per marketplace the cheapest of the first 8
organic (non-sponsored) results is used, ignoring results priced below half their
median, so check the product title shown under each offer to confirm it's the right item.
Prices are as listed on each site: shipping, and whether a marketplace delivers to
you, aren't taken into account.

### bol.com

bol.com has no SerpAPI engine, so it's found through Google Shopping: one search for
`<product> bol.com` (country `BOL_GL`, default `nl`), keeping the cheapest bol.com
listing priced above half the median of all results. If bol.com isn't in the results,
the product shows a "no listing found" note instead of a price. bol.com's own
[Marketing Catalog API](https://api.bol.com/marketing/docs/catalog-api/index.html) would
be more reliable but needs a bol affiliate account; a provider for it would slot into
`providers/` like the others.

### Search budget

Every refresh costs one search per source per product: Google Shopping, one per Amazon
domain and one for bol.com, so 5 by default. The app is built around SerpAPI's free plan
(250 searches a month, set with `SERPAPI_MONTHLY_LIMIT`; `0` turns the limit off):

- It counts every search, saves the count in `data/usage.json` (so restarts don't reset it)
  and shows it under the title. Match `SERPAPI_RESET_DAY` (1-28) to the day your SerpAPI
  plan renews. SerpAPI's dashboard is the source of truth if the two ever differ.
- Unless you set `REFRESH_MINUTES`, products are refreshed as often as the budget allows,
  keeping 15% back for manual "Check now" clicks (never more often than every 6 hours).
- A refresh the remaining budget can't fully cover is skipped, so you never get a snapshot
  with stores missing. The product shows when checks resume.
- "Refresh all" asks before spending.

Roughly how often each product is checked with 250 searches a month:

| Products | 5 searches (default) | 4 searches (`GOOGLE_SHOPPING=0`) |
|---|---|---|
| 1 | every 17 h | every 14 h |
| 2 | every 34 h | every 28 h |
| 3 | every 51 h | every 42 h |
| 5 | every 3.75 days | every 3 days |

Fewer sources stretch it further: turn them off with `GOOGLE_SHOPPING=0`, `BOL=0` or
`AMAZON_DOMAINS=` (empty). If one source fails, the others still update and the product
shows a warning.

Shopping searches can return accessories (a case for the phone you searched for).
Offers priced below 40% of the median are dropped when there are 3 or more offers.
Searching with a specific model name helps most.

To add another source, add a file in `providers/` exporting
`{ name, demo, fetchOffers(query) -> [{ store, price, url }] }` and register it in
`providers/index.js`.

## Configuration

Set these in the environment or in a `.env` file (see `.env.example`).

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | Anything other than localhost requires `AUTH_PASSWORD`. |
| `AUTH_PASSWORD` | none | Asks for this password (any username) on every request. |
| `REFRESH_MINUTES` | `60` demo / paced to the budget live | Pin the interval; `0` disables background refresh |
| `SERPAPI_MONTHLY_LIMIT` | `250` | Searches your SerpAPI plan allows per period; `0` = no limit |
| `SERPAPI_RESET_DAY` | `1` | Day of the month (1-28) your SerpAPI plan renews |
| `CURRENCY` | `EUR` | Display currency (ISO code). All sources should return the same currency. |
| `SERPAPI_GL` | `be` | Country for Google Shopping results |
| `AMAZON_DOMAINS` | `amazon.com.be,amazon.nl,amazon.de` | Amazon marketplaces to compare |
| `GOOGLE_SHOPPING` | on | `0` skips the general Google Shopping search |
| `BOL` | on | `0` skips the bol.com search |
| `BOL_GL` | `nl` | Country used for the bol.com search |
| `DATA_FILE` | `data/db.json` | Where products and price history are stored |
| `PROVIDER` | auto | Force `demo` or `serpapi` |
