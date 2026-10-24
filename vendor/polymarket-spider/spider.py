#!/usr/bin/env python3
"""
Polymarket read-only spider: top wallets by realized PnL + heuristic strategy labels.

Uses official public Data API v2 (no auth, no trading).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://data-api.polymarket.com"
HK = timezone(timedelta(hours=8))
OUT_DIR = Path(__file__).resolve().parent / "output"
USER_AGENT = "polymarket-spider/1.0 (read-only research; contact: local)"


def http_get(path: str, params: dict[str, Any] | None = None, retries: int = 4) -> Any:
    qs = f"?{urlencode({k: v for k, v in (params or {}).items() if v is not None})}"
    url = f"{BASE}{path}{qs}"
    last_err: Exception | None = None
    for attempt in range(retries):
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except HTTPError as e:
            last_err = e
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = float(retry_after) if retry_after else (1.5 * (attempt + 1))
            if e.code in (429, 503, 502, 500):
                time.sleep(wait)
                continue
            raise
        except URLError as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed after {retries} tries: {last_err}")


def fetch_leaderboard(limit: int = 100, time_period: str = "all") -> list[dict[str, Any]]:
    """Page the PnL leaderboard until we have `limit` rows (or board ends)."""
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    page_size = min(100, limit)

    while len(rows) < limit:
        params: dict[str, Any]
        if cursor:
            # Cursor pins board; do not restate sort/window/category.
            params = {"cursor": cursor}
        else:
            params = {
                "time_period": time_period,
                "sort_by": "PNL",
                "category": "overall",
                "limit": page_size,
            }
        payload = http_get("/v2/leaderboard", params)
        batch = payload.get("data") or []
        if not batch:
            break
        rows.extend(batch)
        pag = payload.get("pagination") or {}
        cursor = pag.get("next_cursor")
        if not pag.get("has_more") or not cursor:
            break
        time.sleep(0.15)

    return rows[:limit]


def fetch_user_stats(wallet: str) -> dict[str, Any] | None:
    payload = http_get("/v2/user-stats", {"user": wallet})
    return payload.get("data")


def days_since(epoch: int | None, now: float) -> float | None:
    if not epoch:
        return None
    d = (now - epoch) / 86400.0
    return max(d, 1.0 / 24.0)  # floor ~1 hour


def suspect_strategy(
    *,
    pnl: float,
    volume_shares: float,
    markets: int | None,
    trade_count: int | None,
    biggest_win: float | None,
    maker_rebate: float | None,
    taker_rebate: float | None,
    realized_lp_pnl: float | None,
    trades_per_day: float | None,
) -> tuple[str, str]:
    """
    Heuristic-only labels from public aggregate fields.
    Returns (label, reason). Never invents numbers.
    """
    reasons: list[str] = []
    pnl = float(pnl or 0)
    vol = float(volume_shares or 0)
    tc = int(trade_count or 0)
    mk = int(markets or 0)
    bw = float(biggest_win or 0)
    mr = float(maker_rebate or 0)
    tr = float(taker_rebate or 0)
    lp = float(realized_lp_pnl or 0)
    tpd = float(trades_per_day or 0)

    vol_pnl_ratio = (vol / pnl) if pnl > 0 else None
    win_share = (bw / pnl) if pnl > 0 and bw > 0 else None
    maker_share = (mr / (mr + tr)) if (mr + tr) > 0 else None

    # Strong market-making signals: huge fill count + high turnover + maker rebates
    if tc >= 100_000 and (tpd >= 500 or (vol_pnl_ratio is not None and vol_pnl_ratio >= 20)):
        if maker_share is not None and maker_share >= 0.35:
            reasons.append(f"fills={tc}, trades/day≈{tpd:.0f}, maker_rebate_share={maker_share:.2f}")
            return "market-making", "; ".join(reasons)
        if mk >= 1000 or (vol_pnl_ratio is not None and vol_pnl_ratio >= 50):
            reasons.append(f"fills={tc}, markets={mk}, vol/pnl≈{vol_pnl_ratio:.1f}" if vol_pnl_ratio else f"fills={tc}")
            return "market-making", "; ".join(reasons)

    if lp > 0 and pnl > 0 and (lp / pnl) >= 0.2:
        reasons.append(f"realized_lp_pnl={lp:.0f} ({100 * lp / pnl:.0f}% of pnl)")
        return "market-making", "; ".join(reasons)

    # Resolution / concentrated directional: few markets, outsized single win
    if mk > 0 and mk <= 50 and win_share is not None and win_share >= 0.25:
        reasons.append(f"markets={mk}, biggest_win/pnl={win_share:.2f}")
        return "resolution-sniping", "; ".join(reasons)

    if tc > 0 and tc < 5_000 and mk > 0 and mk <= 100 and win_share is not None and win_share >= 0.15:
        reasons.append(f"low fills={tc}, markets={mk}, biggest_win/pnl={win_share:.2f}")
        return "resolution-sniping", "; ".join(reasons)

    # Arbitrage-ish: many markets, solid fill count, turnover mid-high, not pure maker
    if mk >= 200 and tc >= 10_000 and vol_pnl_ratio is not None and 5 <= vol_pnl_ratio <= 80:
        if maker_share is None or maker_share < 0.7:
            reasons.append(f"markets={mk}, fills={tc}, vol/pnl≈{vol_pnl_ratio:.1f}")
            return "arbitrage", "; ".join(reasons)

    # Copy-trading is not reliably detectable from aggregates alone
    # High-frequency without clear maker edge → still likely bot MM/arb unknown subtype
    if tpd >= 200 and tc >= 50_000:
        reasons.append(f"high frequency trades/day≈{tpd:.0f}, fills={tc}")
        return "market-making", "; ".join(reasons)

    if mk >= 500 and tc >= 20_000:
        reasons.append(f"broad markets={mk}, fills={tc}")
        return "arbitrage", "; ".join(reasons)

    reasons.append("insufficient aggregate signal")
    return "unknown", "; ".join(reasons)


def fmt_num(x: Any, digits: int = 2) -> str:
    if x is None or x == "":
        return ""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return str(x)
    if abs(v) >= 1_000_000:
        return f"{v:,.{digits}f}"
    return f"{v:,.{digits}f}"


def build_rows(entries: list[dict[str, Any]], enrich: bool = True) -> list[dict[str, Any]]:
    now = time.time()
    out: list[dict[str, Any]] = []
    n = len(entries)
    for i, e in enumerate(entries, 1):
        wallet = e.get("user_id") or e.get("wallet") or ""
        pnl = float(e.get("pnl") or 0)
        volume = float(e.get("volume") or 0)
        username = e.get("user_name") or ""
        rank = e.get("rank")

        markets = trade_count = None
        biggest_win = maker_rebate = taker_rebate = realized_lp = None
        join_date = None
        volume_usdc = None
        trades_per_day = None
        strategy = "unknown"
        strategy_reason = "stats not fetched"
        join_date_hk = ""

        if enrich and wallet:
            try:
                stats = fetch_user_stats(wallet)
                time.sleep(0.12)  # stay well under ~80 rps general limit
            except Exception as ex:  # noqa: BLE001 — keep row even if enrich fails
                stats = None
                strategy_reason = f"user-stats error: {ex}"
            if stats:
                markets = stats.get("trades")  # distinct markets
                biggest_win = stats.get("biggest_win")
                join_date = stats.get("join_date")
                atp = stats.get("all_time_pnl") or {}
                trade_count = atp.get("trade_count")
                volume_usdc = atp.get("volume_usdc")
                maker_rebate = atp.get("maker_rebate")
                taker_rebate = atp.get("taker_rebate")
                realized_lp = atp.get("realized_lp_pnl")
                d = days_since(join_date, now)
                if d and trade_count is not None:
                    trades_per_day = float(trade_count) / d
                if join_date:
                    join_date_hk = datetime.fromtimestamp(join_date, tz=HK).strftime(
                        "%Y-%m-%d %H:%M Asia/Hong_Kong"
                    )
                strategy, strategy_reason = suspect_strategy(
                    pnl=pnl,
                    volume_shares=volume,
                    markets=markets,
                    trade_count=trade_count,
                    biggest_win=biggest_win,
                    maker_rebate=maker_rebate,
                    taker_rebate=taker_rebate,
                    realized_lp_pnl=realized_lp,
                    trades_per_day=trades_per_day,
                )
            elif strategy_reason == "stats not fetched":
                strategy_reason = "user-stats returned null"

        # Frequency proxy from leaderboard alone if no stats
        freq_proxy = ""
        if trades_per_day is not None:
            freq_proxy = f"{trades_per_day:.1f} fills/day"
        elif trade_count is not None:
            freq_proxy = f"{trade_count} fills (lifetime)"
        elif volume > 0 and pnl > 0:
            freq_proxy = f"vol/pnl={volume / pnl:.1f} (shares/USDC-pnl)"

        row = {
            "rank": rank,
            "address": wallet,
            "username": username,
            "pnl_usdc": round(pnl, 4),
            "volume_shares": round(volume, 4),
            "volume_usdc": round(float(volume_usdc), 4) if volume_usdc is not None else "",
            "trade_count": trade_count if trade_count is not None else "",
            "markets_traded": markets if markets is not None else "",
            "biggest_win_usdc": round(float(biggest_win), 4) if biggest_win is not None else "",
            "maker_rebate_usdc": round(float(maker_rebate), 4) if maker_rebate is not None else "",
            "taker_rebate_usdc": round(float(taker_rebate), 4) if taker_rebate is not None else "",
            "trade_frequency_proxy": freq_proxy,
            "join_date": join_date_hk,
            "suspected_strategy": strategy,
            "strategy_reason": strategy_reason,
            "x_username": e.get("x_username") or "",
            "verified": e.get("verified", False),
        }
        out.append(row)
        print(f"[{i}/{n}] rank={rank} {username or wallet[:10]}… pnl={pnl:,.0f} → {strategy}", flush=True)
    return out


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def write_markdown(path: Path, rows: list[dict[str, Any]], meta: dict[str, Any]) -> None:
    lines = [
        "# Polymarket Top Wallets by Realized PnL",
        "",
        f"- Generated: **{meta['generated_hk']}**",
        f"- Source: `{meta['endpoint']}`",
        f"- Window: `{meta['time_period']}` (all = realized-only lifetime ledger)",
        f"- Rows: **{len(rows)}**",
        f"- Strategy labels: **heuristic only** from leaderboard + `/v2/user-stats` aggregates",
        "",
        "| rank | username | address | pnl_usdc | volume_shares | trade_count | markets | fills/day proxy | suspected_strategy |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for r in rows:
        addr = r["address"]
        short = f"`{addr[:6]}…{addr[-4:]}`" if addr else ""
        lines.append(
            "| {rank} | {user} | {addr} | {pnl} | {vol} | {tc} | {mk} | {freq} | {strat} |".format(
                rank=r["rank"],
                user=(r["username"] or "—").replace("|", "/"),
                addr=short,
                pnl=fmt_num(r["pnl_usdc"], 0),
                vol=fmt_num(r["volume_shares"], 0),
                tc=r["trade_count"] if r["trade_count"] != "" else "—",
                mk=r["markets_traded"] if r["markets_traded"] != "" else "—",
                freq=(r["trade_frequency_proxy"] or "—").replace("|", "/"),
                strat=r["suspected_strategy"],
            )
        )
    lines.extend(
        [
            "",
            "## Notes",
            "",
            "- `volume_shares` from the leaderboard is **both-sides share volume**, not USDC.",
            "- `markets_traded` from user-stats is **distinct markets**, not fills.",
            "- `trade_count` is cumulative maker-attributed fills from user-stats `all_time_pnl`.",
            "- `suspected_strategy` is **not** ground truth; copy-trading especially cannot be detected from aggregates.",
            "",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Polymarket top-PnL wallet spider (read-only)")
    ap.add_argument("--limit", type=int, default=100, help="How many wallets (max useful ~1000/page)")
    ap.add_argument("--time-period", default="all", choices=["day", "week", "month", "all"])
    ap.add_argument("--no-enrich", action="store_true", help="Skip /v2/user-stats (faster, weaker labels)")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(tz=HK)
    stamp = generated.strftime("%Y%m%d_%H%M%S")

    print(f"Fetching leaderboard time_period={args.time_period} limit={args.limit} …", flush=True)
    entries = fetch_leaderboard(limit=args.limit, time_period=args.time_period)
    print(f"Got {len(entries)} leaderboard rows. Enriching…", flush=True)

    rows = build_rows(entries, enrich=not args.no_enrich)

    csv_path = args.out_dir / f"top{len(rows)}_pnl_{args.time_period}_{stamp}.csv"
    md_path = args.out_dir / f"top{len(rows)}_pnl_{args.time_period}_{stamp}.md"
    latest_csv = args.out_dir / "latest.csv"
    latest_md = args.out_dir / "latest.md"
    raw_path = args.out_dir / f"raw_leaderboard_{stamp}.json"

    raw_path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    write_csv(csv_path, rows)
    meta = {
        "generated_hk": generated.strftime("%Y-%m-%d %H:%M:%S Asia/Hong_Kong"),
        "endpoint": f"{BASE}/v2/leaderboard",
        "time_period": args.time_period,
    }
    write_markdown(md_path, rows, meta)
    write_csv(latest_csv, rows)
    write_markdown(latest_md, rows, meta)

    # Also dump strategy distribution
    from collections import Counter

    dist = Counter(r["suspected_strategy"] for r in rows)
    summary = {
        "generated_hk": meta["generated_hk"],
        "rows": len(rows),
        "strategy_counts": dict(dist),
        "csv": str(csv_path),
        "markdown": str(md_path),
        "raw_leaderboard": str(raw_path),
    }
    (args.out_dir / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("\nDone.")
    print(json.dumps(summary, indent=2))
    print("\nTop 10 preview:")
    for r in rows[:10]:
        print(
            f"  #{r['rank']:>3} {r['username'] or r['address'][:12]:20} "
            f"pnl={r['pnl_usdc']:>14,.0f}  {r['suspected_strategy']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
