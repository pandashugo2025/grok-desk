# GROK DESK — Paper Simulator

Dense cyberpunk multi-agent desk UI inspired by viral Polymarket “GROK DESK / Hawkes” posts.
**Paper trading only** — no keys, no CLOB order signing, no live posts.

## Run (local)

```bash
python3 /workspace/grok-desk/run.py
# optional: --port 8765 --interval 3 --size 25
```

- UI:  http://127.0.0.1:8765/?v=mind15
- API: http://127.0.0.1:8765/api/state
- State snapshot: `state/latest.json`
- Cycle log: `output/cycles.jsonl`

Hard-refresh after UI edits (`?v=mind15` or Cmd/Ctrl+Shift+R).

## Public URL (temporary quick tunnel)

From a machine that can reach the open internet (e.g. your Mac):

```bash
# requires cloudflared: brew install cloudflared
./scripts/start-public.sh
# prints URL and writes output/public-url.txt
```

Quick tunnels give a random `*.trycloudflare.com` host that **changes** when the tunnel restarts. Keep the Mac awake and the script’s processes running.

### Stable domain options (optional — tokens not required in this repo)

**Cloudflare named tunnel** (fixed hostname you control):

1. `cloudflared tunnel login` (once, in a browser).
2. `cloudflared tunnel create grok-desk`
3. Map a DNS CNAME, e.g. `desk.example.com` → `<tunnel-id>.cfargotunnel.com`.
4. Config sketch (`~/.cloudflared/config.yml`):

```yaml
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json
ingress:
  - hostname: desk.example.com
    service: http://127.0.0.1:8765
  - service: http_status:404
```

5. `cloudflared tunnel run grok-desk`

**ngrok** (stable subdomain on a paid plan):

```bash
# brew install ngrok && ngrok config add-authtoken <token>
ngrok http 8765 --domain=your-fixed.ngrok-free.app
```

Do not commit Cloudflare credentials, ngrok authtokens, or wallet keys into this tree.

## UI panels (vs reference)

| Panel | Status |
|---|---|
| Top metrics + UTC clock + SWARM ONLINE | Live from `/api/state` |
| Agent bar EDGE/CLOSER/PRIOR/TAKER/SPOTTER/KELLY | Real pipeline statuses |
| LIVE WIRE ticker | Real handoff/trace strings |
| Desk Floor (isometric office) | Aesthetic canvas; click bot → THE MIND |
| THE MIND armillary + orbiting agents | Aesthetic canvas (intensity/bias/action) |
| SIGNALS IN gauges | Real fields; PERP BASIS = CLOB mid vs Gamma (or N/A) |
| COMMAND STACK + handoffs | Real agent log |
| SWARM PnL chart | Paper equity curve |
| Mobile ≤768 / ≤390 | Stacked layout, side tabs, ZH/EN toggle |

Subtle **PAPER · SIM** / **紙上 · 模擬** tag always visible. Default UI language: 繁體中文 (`EN | 繁中` in top bar).


## 跟倉觀察 / FOLLOW (paper)

Top-100 Polymarket wallets from `../polymarket-spider/output/latest.csv` (auto-refresh spider if CSV missing or >12h old).

| Endpoint | Purpose |
|---|---|
| `GET /api/wallets` | List/filter: `strategy`, `min_pnl`, `q`, `limit` |
| `GET /api/wallets/{addr}/recent` | Public activity + trades + gamma profile (cached ~90s; `nocache=1`) |
| `GET /api/wallets/refresh` | Force spider re-run (background) + CSV age |
| `POST /api/wallets/watch` | Set watched addresses + focus + interval (5–120s) |
| `GET /api/wallets/stream` | SSE near-live activity hints (`type:activity`) |


UI: top nav **跟倉觀察 / FOLLOW** — table + detail (activity, markets, **local-only** notes in `localStorage`). No keys, no CLOB orders.

## Signals

- Hawkes-lite λ on tape timestamps + synthetic micro-events when tape thin
- Stronger last-minute ramp in final 60–120s
- DMI/ADX, momentum, short-term vol, flow / book imbalance, basis proxy
- 18 named features exposed for spectrogram
- Model ¢ card: spot-vs-open + vol + time-to-resolve prior, adjusted by book/flow

## Architecture

```
spider/   MarketSpider + SpotSpider + wallets (top-100 follow)
signals/  Hawkes + DMI/ADX + last-min → BUY_UP|BUY_DOWN|HOLD + features
agents/   SPOTTER→PRIOR→EDGE→KELLY→TAKER→CLOSER + PaperPortfolio
ui/       Dense neon desk (polls /api/state) — floor.js + mind.js
scripts/  start-public.sh (run.py + cloudflared quick tunnel)
run.py    Loop + ThreadingHTTPServer
```

## Out of scope

Wallet / private key / EIP-712 signing / live orders / production risk kill-switch.
