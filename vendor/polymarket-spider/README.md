# Polymarket Spider (read-only)

Pulls the official Polymarket **trader leaderboard** by realized PnL, enriches each wallet with `/v2/user-stats`, and writes CSV + Markdown tables with a **heuristic** `suspected_strategy` label.

**Not a trading bot.** No orders, no keys, no CLOB writes — HTTP GET only against public Data API v2.

## Quick start

```bash
cd /workspace/polymarket-spider
python3 spider.py --limit 100 --time-period all
```

Outputs land in `output/`:

| File | Purpose |
| --- | --- |
| `latest.csv` / `latest.md` | Always overwritten with the newest run |
| `top{N}_pnl_{window}_{timestamp}.csv/.md` | Timestamped copies |
| `raw_leaderboard_{timestamp}.json` | Raw leaderboard page payload |
| `run_summary.json` | Row count + strategy distribution |

Options:

```bash
python3 spider.py --limit 50 --time-period week
python3 spider.py --limit 100 --no-enrich   # leaderboard only (weaker labels)
```

Dependencies: **stdlib only** (`urllib`, `csv`, `json`). No `pip install`.

## Endpoints that worked

| API | URL | Used? | Notes |
| --- | --- | --- | --- |
| **Data API v2 leaderboard** | `GET https://data-api.polymarket.com/v2/leaderboard` | **Yes (primary)** | `time_period=all\|day\|week\|month`, `sort_by=PNL\|VOLUME`, `category=overall`, cursor pagination via `pagination.next_cursor` |
| **Data API v2 user-stats** | `GET https://data-api.polymarket.com/v2/user-stats?user=0x…` | **Yes (enrich)** | Distinct markets (`trades`), `biggest_win`, `join_date`, `all_time_pnl.{trade_count,volume_usdc,maker_rebate,taker_rebate,…}` |
| Data API v1 leaderboard | `GET https://data-api.polymarket.com/v1/leaderboard` | Verified live, not used | Same ranking; limit≤50/page + offset. Prefer v2. |
| Gamma API | `https://gamma-api.polymarket.com` | Not needed | Markets/events metadata |
| CLOB | `https://clob.polymarket.com` | Not needed | Order books / trading |
| `/v2/trades?user=` | Available | **Not bulk-fetched** | Needed for deep strategy RE; 300 req/10s |

Docs: https://docs.polymarket.com/api-reference/boards/get-the-trader-leaderboard  
OpenAPI: https://data-api.polymarket.com/v2/openapi.json

### Semantics (important)

- `time_period=all` → **realized-only lifetime** PnL ledger.
- Finite windows (`day`/`week`/`month`) → **marked** equity change (includes unrealized); not the same number as `all`.
- Leaderboard `volume` = **both-sides share volume**, not USDC.
- user-stats `trades` = **distinct markets**, not fills.
- user-stats `all_time_pnl.trade_count` = cumulative fill count (used for frequency).

## Rate limits observed / documented

From Polymarket docs (IP / Cloudflare sliding window):

| Scope | Limit |
| --- | --- |
| Data API v2 general (all `/v2/*`) | **800 req / 10s** |
| `/v2/trades` | 300 / 10s |
| `/v2/positions`, `/v2/activity`, `/v2/prices-history` | 200 / 10s |

This spider sleeps ~120ms between user-stats calls (~8 rps) and retries on 429/503 with `Retry-After`. A full top-100 enrich run completed in ~27s from this box with **no 429s**.

## Strategy labels (honest limits)

Labels are **heuristics from aggregates only**, written into `suspected_strategy` + `strategy_reason`:

| Label | Typical signals |
| --- | --- |
| `market-making` | Very high fill count / fills-per-day, high vol/pnl, significant `maker_rebate` share, or LP PnL |
| `arbitrage` | Many markets + solid fills + mid-high turnover without pure-maker skew |
| `resolution-sniping` | Few markets + large `biggest_win / pnl` (concentrated resolved wins) |
| `copy-trading` | **Never assigned** — not detectable from aggregates alone |
| `unknown` | No rule fired |

**Caveats**

- `resolution-sniping` also catches informed / concentrated directional winners (e.g. election whales). It is **not** proof of UMA/resolution timing bots.
- `market-making` is the most reliable label when fill rates are thousands per day.
- No label invents PnL — all money fields come from the API.

This run's distribution (2026-10-21 Asia/Hong_Kong): ~45 resolution-sniping, ~32 market-making, ~14 arbitrage, ~9 unknown.

## What we could NOT get (yet)

1. Per-fill trade tapes for all 100 wallets (would be millions of rows; needs pagination + storage).
2. True copy-trading detection (needs cross-wallet correlation of fills).
3. Exact “bot vs human” classification (no official flag).
4. USDC volume on the leaderboard itself (share volume only; USDC comes from user-stats).
5. Live order-book maker/taker flags per fill without `/v2/trades` deep crawl (`taker_only=false`).

## Next steps for deeper strategy reverse-engineering

1. For top N wallets, page `/v2/trades?user=…&start=1&taker_only=false` and compute: trade gap histogram, hour-of-day activity, price vs mid, maker vs taker share, markets near resolution.
2. Cross-check wallets that buy the same markets within seconds → copy-trading clusters.
3. Join Gamma market `endDate` / resolution timestamps to detect sniping windows.
4. Optional: Polygon on-chain CTF fills via Dune for wallets missing from Data API.

## Re-run checklist

```bash
python3 /workspace/polymarket-spider/spider.py --limit 100 --time-period all
# inspect
head -20 /workspace/polymarket-spider/output/latest.md
cat /workspace/polymarket-spider/output/run_summary.json
```
