# Pricewatch

A small dashboard that tracks the best online price for products you care about.
Add a product, optionally set a target price, and Pricewatch re-checks the stores
on a schedule, keeps the price history, and shows the cheapest current offer, the
change since the last check, and a price chart.

No dependencies; needs Node 20+.

```sh
npm start          # http://127.0.0.1:3000
npm test
```

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
domain and one for bol.com, so 5 by default. SerpAPI's free tier is small (about 100
searches a month), so live prices refresh once a day by default, which is less than one
product's worth on the free tier. Turn sources off with `GOOGLE_SHOPPING=0`, `BOL=0` or
`AMAZON_DOMAINS=` (empty), or raise `REFRESH_MINUTES` on a paid plan. If one source fails,
the others still update and the product shows a warning.

Shopping searches can return accessories (a case for the phone you searched for).
Offers priced below 40% of the median are dropped when there are 3 or more offers.
Searching with a specific model name helps most.

To add another source, add a file in `providers/` exporting
`{ name, demo, fetchOffers(query) -> [{ store, price, url }] }` and register it in
`providers/index.js`.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | The API has no auth; only change this behind something that does. |
| `REFRESH_MINUTES` | `60` demo / `1440` live | `0` disables background refresh |
| `CURRENCY` | `EUR` | Display currency (ISO code). All sources should return the same currency. |
| `SERPAPI_GL` | `be` | Country for Google Shopping results |
| `AMAZON_DOMAINS` | `amazon.com.be,amazon.nl,amazon.de` | Amazon marketplaces to compare |
| `GOOGLE_SHOPPING` | on | `0` skips the general Google Shopping search |
| `BOL` | on | `0` skips the bol.com search |
| `BOL_GL` | `nl` | Country used for the bol.com search |
| `DATA_FILE` | `data/db.json` | Where products and price history are stored |
| `PROVIDER` | auto | Force `demo` or `serpapi` |
