"""Lightweight DMI / ADX on OHLCV candles."""
from __future__ import annotations

import math
from typing import Any


def _rma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    alpha = 1.0 / period
    prev = seed
    for i in range(period, len(values)):
        prev = prev + alpha * (values[i] - prev)
        out[i] = prev
    return out


def compute_dmi_adx(candles: list[dict[str, float]], period: int = 14) -> dict[str, float]:
    """Return plus_di, minus_di, adx, direction (+1 / -1 / 0)."""
    if len(candles) < period + 2:
        return {"plus_di": 0.0, "minus_di": 0.0, "adx": 0.0, "direction": 0.0}

    plus_dm: list[float] = []
    minus_dm: list[float] = []
    tr_list: list[float] = []
    for i in range(1, len(candles)):
        h = candles[i]["h"]
        l = candles[i]["l"]
        prev_c = candles[i - 1]["c"]
        prev_h = candles[i - 1]["h"]
        prev_l = candles[i - 1]["l"]
        up_move = h - prev_h
        down_move = prev_l - l
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        tr_list.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))

    atr = _rma(tr_list, period)
    pdm = _rma(plus_dm, period)
    mdm = _rma(minus_dm, period)

    dx_vals: list[float] = []
    plus_di = 0.0
    minus_di = 0.0
    for i in range(len(atr)):
        a = atr[i]
        p = pdm[i]
        m = mdm[i]
        if a is None or p is None or m is None or a == 0:
            continue
        pdi = 100.0 * (p / a)
        mdi = 100.0 * (m / a)
        plus_di, minus_di = pdi, mdi
        denom = pdi + mdi
        dx_vals.append(100.0 * abs(pdi - mdi) / denom if denom else 0.0)

    adx = 0.0
    if len(dx_vals) >= period:
        adx_series = _rma(dx_vals, period)
        for v in reversed(adx_series):
            if v is not None and not math.isnan(v):
                adx = v
                break

    direction = 0.0
    if adx >= 18:
        if plus_di > minus_di + 2:
            direction = 1.0
        elif minus_di > plus_di + 2:
            direction = -1.0

    return {
        "plus_di": round(plus_di, 2),
        "minus_di": round(minus_di, 2),
        "adx": round(adx, 2),
        "direction": direction,
    }
