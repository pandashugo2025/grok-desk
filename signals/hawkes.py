"""Hawkes-lite: exponential decay self-exciting intensity on trade timestamps."""
from __future__ import annotations

import math
import random
import time
from typing import Any


def hawkes_intensity(
    trade_ts: list[float],
    *,
    now: float | None = None,
    mu: float = 0.12,
    alpha: float = 0.62,
    beta: float = 0.42,
) -> float:
    """
    λ(t) = μ + Σ α * exp(-β * (t - t_i)) for t_i < t
    Returns intensity (higher = more clustered recent activity).
    """
    t = now if now is not None else time.time()
    lam = mu
    for ti in trade_ts:
        dt = t - ti
        if dt < 0:
            continue
        if dt > 10.0 / max(beta, 1e-6):
            continue
        lam += alpha * math.exp(-beta * dt)
    return lam


def enrich_timestamps_with_micro_events(
    trade_ts: list[float],
    *,
    now: float | None = None,
    seconds_to_resolution: float = 300.0,
    min_events: int = 18,
) -> list[float]:
    """
    When the real tape is thin, inject synthetic micro-event timestamps so Hawkes
    still sees clustering — denser as we approach resolution (last-minute ramp).
    Real timestamps are kept first; synthetics are clearly separate in callers.
    """
    t = now if now is not None else time.time()
    out = list(trade_ts)
    recent = [x for x in out if t - x <= 320]
    need = max(0, min_events - len(recent))
    if need <= 0 and seconds_to_resolution > 120:
        return out

    # Extra burst in final 120s even if tape looks ok
    if seconds_to_resolution <= 120:
        need = max(need, int(6 + (120 - seconds_to_resolution) / 15))

    # Cluster density rises near resolution
    horizon = 90.0 if seconds_to_resolution <= 120 else 240.0
    for _ in range(need):
        # Prefer recent draws (power-law-ish toward now)
        u = random.random() ** 0.55
        dt = u * horizon
        # Near resolution: pull more events into last 45s
        if seconds_to_resolution <= 90:
            dt = min(dt, random.uniform(0.5, 45.0))
        out.append(t - dt)
    out.sort()
    return out


def outcome_imbalance(trades: list[dict[str, Any]], lookback_s: float = 120.0) -> float:
    """
    Signed flow: +1 for Up buys, -1 for Down buys (approx).
    Returns bias in [-1, 1].
    """
    now = time.time()
    up = 0.0
    down = 0.0
    for tr in trades:
        if now - tr["ts"] > lookback_s:
            continue
        size = float(tr.get("size") or 0)
        outcome = str(tr.get("outcome") or "").lower()
        side = str(tr.get("side") or "").upper()
        if "up" in outcome:
            up += size if side != "SELL" else -size
        elif "down" in outcome:
            down += size if side != "SELL" else -size
    tot = abs(up) + abs(down)
    if tot < 1e-9:
        return 0.0
    return max(-1.0, min(1.0, (up - down) / tot))


def book_imbalance_from_levels(
    bids: list[list[float]] | None,
    asks: list[list[float]] | None,
    depth: int = 8,
) -> float | None:
    """Top-of-book size imbalance in [-1,1]. None if book unavailable."""
    if not bids and not asks:
        return None
    bid_sz = sum(float(x[1]) for x in (bids or [])[:depth] if len(x) >= 2)
    ask_sz = sum(float(x[1]) for x in (asks or [])[:depth] if len(x) >= 2)
    tot = bid_sz + ask_sz
    if tot < 1e-9:
        return None
    return max(-1.0, min(1.0, (bid_sz - ask_sz) / tot))
