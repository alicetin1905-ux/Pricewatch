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
| `serpapi` | `SERPAPI_KEY` is set | Real Google Shopping results via [SerpAPI](https://serpapi.com). |

```sh
SERPAPI_KEY=your-key npm start
```

SerpAPI's free tier is small, so with a live source prices refresh every 12 hours
by default (hourly for the demo). Each refresh costs one search per product.

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
| `REFRESH_MINUTES` | `60` demo / `720` live | `0` disables background refresh |
| `CURRENCY` | `USD` | Display currency (ISO code) |
| `SERPAPI_GL` | `us` | Country for Google Shopping results |
| `DATA_FILE` | `data/db.json` | Where products and price history are stored |
| `PROVIDER` | auto | Force `demo` or `serpapi` |
