"""Combine Hawkes intensity, last-minute factor, DMI/ADX → paper action + feature vector."""
from __future__ import annotations

import math
import time
from typing import Any

from .dmi import compute_dmi_adx
from .hawkes import (
    book_imbalance_from_levels,
    enrich_timestamps_with_micro_events,
    hawkes_intensity,
    outcome_imbalance,
)

# Named spectrogram slots (pad trailing with honest zero labels only if short)
FEATURE_NAMES = [
    "mom",
    "vol",
    "plus_di",
    "minus_di",
    "adx",
    "basis",
    "time_left",
    "imbalance",
    "flow",
    "intensity",
    "confidence",
    "last_min",
    "bias",
    "up_px",
    "down_px",
    "price_edge",
    "vol_spike",
    "hawkes_raw",
]


class SignalEngine:
    def __init__(self, last_minute_s: float = 120.0) -> None:
        self.last_minute_s = last_minute_s
        self._feature_history: list[list[float]] = []  # recent frames for spectrogram
        self._window_open_spot: float | None = None
        self._window_id: Any = None

    def _last_minute_ramp(self, ttr: float) -> float:
        """
        Stronger ramp in final 60–120s.
        ~0.2 early → ~0.55 at 120s → ~0.85 at 60s → ~1.0 at 0s
        """
        if ttr <= 0:
            return 1.0
        if ttr <= 60:
            # 60→0: 0.85 → 1.0 (steep)
            return 0.85 + 0.15 * (1.0 - ttr / 60.0)
        if ttr <= 120:
            # 120→60: 0.55 → 0.85
            return 0.55 + 0.30 * (1.0 - (ttr - 60.0) / 60.0)
        if ttr <= 300:
            # 300→120: 0.20 → 0.55
            return 0.20 + 0.35 * (1.0 - (ttr - 120.0) / 180.0)
        return 0.12

    def evaluate(
        self,
        *,
        trades: list[dict[str, Any]],
        candles: list[dict[str, float]],
        up_price: float,
        down_price: float,
        seconds_to_resolution: float,
        spot: float | None = None,
        market: dict[str, Any] | None = None,
        book: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        market = market or {}
        book = book or {}

        # Track spot at window open for Spot vs Open gauge
        wid = market.get("window") or market.get("slug")
        if wid != self._window_id:
            self._window_id = wid
            self._window_open_spot = float(spot) if spot else None
        if self._window_open_spot is None and spot:
            self._window_open_spot = float(spot)

        spot_vs_open = 0.0
        spot_vs_open_raw: float | None = None
        if spot and self._window_open_spot:
            spot_vs_open_raw = float(spot) - float(self._window_open_spot)
            # dollars → display-friendly scale (~tens)
            spot_vs_open = max(-100.0, min(100.0, spot_vs_open_raw))

        ts_list = [float(t["ts"]) for t in trades]
        recent_ts = [t for t in ts_list if now - t <= 320]
        enriched = enrich_timestamps_with_micro_events(
            recent_ts or ts_list,
            now=now,
            seconds_to_resolution=seconds_to_resolution,
            min_events=18,
        )
        used_synthetic_tape = len(enriched) > len(recent_ts or ts_list)

        intensity = hawkes_intensity(enriched, now=now)
        # Near resolution, amplify baseline so last-minute clustering shows up
        ttr = max(0.0, seconds_to_resolution)
        if ttr <= 120:
            intensity *= 1.0 + 0.55 * (1.0 - ttr / 120.0)
        intensity_n = max(0.0, min(1.0, (intensity - 0.12) / 4.0))

        # Short-term vol + momentum from candles
        mom = 0.0
        vol = 0.0
        vol_spike = 0.0
        if len(candles) >= 5:
            c0 = candles[-5]["c"]
            c1 = candles[-1]["c"]
            if c0:
                mom = max(-1.0, min(1.0, (c1 - c0) / c0 * 80.0))
            rets = []
            for i in range(1, min(20, len(candles))):
                a = candles[-i - 1]["c"]
                b = candles[-i]["c"]
                if a:
                    rets.append((b - a) / a)
            if rets:
                mean = sum(rets) / len(rets)
                var = sum((r - mean) ** 2 for r in rets) / len(rets)
                vol = math.sqrt(var) * math.sqrt(60)  # rough annualization-lite → 1m scale
            vols = [c["v"] for c in candles[-10:]]
            v_avg = sum(vols) / len(vols) if vols else 0
            v_now = candles[-1]["v"]
            if v_avg > 0:
                vol_spike = max(0.0, min(1.0, (v_now / v_avg - 0.5)))
                intensity_n = max(
                    intensity_n, min(1.0, 0.15 + 0.40 * vol_spike)
                )

        flow = outcome_imbalance(trades, lookback_s=120.0)
        dmi = compute_dmi_adx(candles, period=14)

        # Book imbalance if levels present; else flow proxy (labeled)
        book_imb = book_imbalance_from_levels(book.get("bids"), book.get("asks"))
        imbalance_source = "book"
        if book_imb is None:
            book_imb = flow  # proxy
            imbalance_source = "flow_proxy" if trades else "n/a"

        last_min = self._last_minute_ramp(ttr)

        # Basis proxy: CLOB mid vs Gamma outcome price (not true perp — honest label)
        basis = 0.0
        basis_available = False
        clob_mid = market.get("clob_mid_up")
        if clob_mid is not None and up_price:
            basis = (float(clob_mid) - float(up_price)) * 100.0  # cents-ish
            basis_available = True

        price_edge = 0.0
        if up_price < 0.45:
            price_edge += 0.25
        if down_price < 0.45:
            price_edge -= 0.25
        if up_price > 0.75:
            price_edge -= 0.12
        if down_price > 0.75:
            price_edge += 0.12
        # Last-minute: lean into price that is already winning if intensity high
        if ttr <= 90 and intensity_n > 0.4:
            if up_price >= 0.58:
                price_edge += 0.18 * last_min
            elif down_price >= 0.58:
                price_edge -= 0.18 * last_min

        bias = (
            0.28 * flow
            + 0.30 * dmi["direction"]
            + 0.18 * mom
            + 0.14 * price_edge
            + 0.10 * (book_imb or 0.0)
        )
        bias = max(-1.0, min(1.0, bias))

        adx_n = min(1.0, (dmi["adx"] or 0) / 35.0)
        confidence = max(
            0.0,
            min(
                1.0,
                0.22 * intensity_n
                + 0.34 * last_min
                + 0.24 * adx_n * abs(bias)
                + 0.20 * min(1.0, abs(bias)),
            ),
        )
        # Extra last-minute confidence bump
        if ttr <= 60:
            confidence = min(1.0, confidence + 0.08 * intensity_n)

        thr = 0.16 if last_min > 0.75 else (0.20 if last_min > 0.55 else 0.26)
        action = "HOLD"
        if confidence >= thr and abs(bias) >= (0.07 if last_min > 0.75 else 0.10):
            action = "BUY_UP" if bias > 0 else "BUY_DOWN"
        if dmi["adx"] < 12 and last_min < 0.55:
            action = "HOLD"
            confidence *= 0.75

        # ---- Model probability of UP at resolution ----
        # Driftless Brownian on spot from window open: P(S_T > S_open) = Phi(d),
        # d = (spot - open) / (spot * sigma_1m * sqrt(minutes_left)), sigma_1m from candle returns.
        # Then tilt in logit space by the swarm bias (flow / DMI / momentum / edge / book),
        # weighted by Hawkes intensity_n.
        sigma_1m = vol / math.sqrt(60.0) if vol > 0 else 0.0
        mins_left = max(ttr, 5.0) / 60.0
        if spot and spot_vs_open_raw is not None and sigma_1m > 0:
            d = spot_vs_open_raw / (float(spot) * sigma_1m * math.sqrt(mins_left))
            d = max(-6.0, min(6.0, d))
            p_diff = 0.5 * (1.0 + math.erf(d / math.sqrt(2.0)))
            model_p_source = "brownian+bias"
        else:
            p_diff = 0.5
            model_p_source = "bias_only"
        p_diff = min(0.995, max(0.005, p_diff))
        logit = math.log(p_diff / (1.0 - p_diff)) + 0.9 * bias * (0.5 + 0.5 * intensity_n)
        model_p_up = 1.0 / (1.0 + math.exp(-logit))
        model_p_up = min(0.99, max(0.01, model_p_up))
        model_edge_up = model_p_up - float(up_price or 0.5)

        # Time-left normalized 0..1 (1 = about to resolve)
        time_left_n = max(0.0, min(1.0, 1.0 - ttr / 300.0))

        features = {
            "mom": round(mom, 4),
            "vol": round(vol, 6),
            "plus_di": round((dmi["plus_di"] or 0) / 100.0, 4),
            "minus_di": round((dmi["minus_di"] or 0) / 100.0, 4),
            "adx": round(adx_n, 4),
            "basis": round(max(-1.0, min(1.0, basis / 10.0)), 4) if basis_available else 0.0,
            "time_left": round(time_left_n, 4),
            "imbalance": round(float(book_imb or 0.0), 4),
            "flow": round(flow, 4),
            "intensity": round(intensity_n, 4),
            "confidence": round(confidence, 4),
            "last_min": round(last_min, 4),
            "bias": round((bias + 1) / 2, 4),  # map to 0..1 for heatmap
            "up_px": round(up_price, 4),
            "down_px": round(down_price, 4),
            "price_edge": round((price_edge + 1) / 2, 4),
            "vol_spike": round(vol_spike, 4),
            "hawkes_raw": round(max(0.0, min(1.0, intensity / 5.0)), 4),
        }
        feature_vector = [float(features[n]) for n in FEATURE_NAMES]
        self._feature_history.append(feature_vector)
        if len(self._feature_history) > 36:
            self._feature_history = self._feature_history[-36:]

        return {
            "action": action,
            "bias": round(bias, 4),
            "intensity": round(intensity, 4),
            "intensity_n": round(intensity_n, 4),
            "confidence": round(confidence, 4),
            "last_minute_factor": round(last_min, 4),
            "seconds_to_resolution": round(ttr, 1),
            "flow": round(flow, 4),
            "mom": round(mom, 4),
            "vol": round(vol, 6),
            "vol_spike": round(vol_spike, 4),
            "spot_vs_open": round(spot_vs_open, 2) if spot_vs_open_raw is not None else None,
            "spot_vs_open_raw": round(spot_vs_open_raw, 2) if spot_vs_open_raw is not None else None,
            "book_imbalance": round(float(book_imb), 4) if book_imb is not None else None,
            "imbalance_source": imbalance_source,
            "perp_basis": round(basis, 3) if basis_available else None,
            "basis_label": "clob_mid_vs_gamma" if basis_available else "n/a",
            "price_edge": round(price_edge, 4),
            "model_p_up": round(model_p_up, 4),
            "model_p_down": round(1.0 - model_p_up, 4),
            "model_up_cents": round(model_p_up * 100.0, 1),
            "model_down_cents": round((1.0 - model_p_up) * 100.0, 1),
            "model_edge_up_cents": round(model_edge_up * 100.0, 1),
            "model_p_source": model_p_source,
            "dmi": dmi,
            "up_price": up_price,
            "down_price": down_price,
            "spot": spot,
            "window_open_spot": self._window_open_spot,
            "used_synthetic_micro_events": used_synthetic_tape,
            "features": features,
            "feature_names": list(FEATURE_NAMES),
            "feature_vector": feature_vector,
            "spectrogram": [row[:] for row in self._feature_history],
            "ts": now,
        }
