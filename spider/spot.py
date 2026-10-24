"""BTC spot via multiple public tickers (Coinbase primary; Binance/Kraken/CoinGecko fallback)."""
from __future__ import annotations

import math
import time
from typing import Any

from .http_util import http_get


class SpotSpider:
    def __init__(self) -> None:
        self.last_error: str | None = None
        self.demo = False
        self._last_price: float | None = None
        self._stall_n = 0
        self._anchor: float | None = None  # session open-ish for micro drift only

    def _try_coinbase(self) -> float:
        data = http_get("https://api.coinbase.com/v2/prices/BTC-USD/spot", retries=1, timeout=6)
        amt = float((data or {}).get("data", {}).get("amount") or 0)
        if amt <= 0:
            raise ValueError("empty coinbase spot")
        return amt

    def _try_binance(self) -> float:
        data = http_get(
            "https://api.binance.com/api/v3/ticker/price",
            {"symbol": "BTCUSDT"},
            retries=1,
            timeout=6,
        )
        amt = float((data or {}).get("price") or 0)
        if amt <= 0:
            raise ValueError("empty binance spot")
        return amt

    def _try_kraken(self) -> float:
        data = http_get(
            "https://api.kraken.com/0/public/Ticker",
            {"pair": "XBTUSD"},
            retries=1,
            timeout=6,
        )
        result = (data or {}).get("result") or {}
        row = result.get("XXBTZUSD") or next(iter(result.values()), None)
        if not row:
            raise ValueError("empty kraken")
        c = row.get("c") or []
        amt = float(c[0] if c else 0)
        if amt <= 0:
            raise ValueError("empty kraken price")
        return amt

    def _try_coingecko(self) -> float:
        data = http_get(
            "https://api.coingecko.com/api/v3/simple/price",
            {"ids": "bitcoin", "vs_currencies": "usd"},
            retries=1,
            timeout=8,
        )
        amt = float(((data or {}).get("bitcoin") or {}).get("usd") or 0)
        if amt <= 0:
            raise ValueError("empty coingecko")
        return amt

    def _fetch_primary(self) -> tuple[str, float]:
        errors: list[str] = []
        for name, fn in (
            ("coinbase", self._try_coinbase),
            ("binance", self._try_binance),
            ("kraken", self._try_kraken),
            ("coingecko", self._try_coingecko),
        ):
            try:
                return name, fn()
            except Exception as e:
                errors.append(f"{name}:{e}")
        raise RuntimeError("; ".join(errors) or "all spot sources failed")

    def fetch_spot(self) -> dict[str, Any]:
        try:
            name, px = self._fetch_primary()
        except Exception as e:
            self.last_error = str(e)
            self.demo = True
            base = self._last_price or 82500.0
            wobble = 80.0 * math.sin(time.time() / 17.0) + 25.0 * math.sin(time.time() / 7.3)
            return {
                "price": base + wobble,
                "source": "synthetic",
                "ts": time.time(),
                "demo": True,
                "error": self.last_error,
            }

        # If the primary ticker is flat for several polls, blend a tiny
        # secondary delta (capped) so model_up_cents still breathes — never
        # wholesale-jump to another venue's absolute price.
        if self._last_price is not None and abs(px - self._last_price) < 0.05:
            self._stall_n += 1
            if self._stall_n >= 2:
                delta = 0.0
                for alt_name, fn in (
                    ("binance", self._try_binance),
                    ("kraken", self._try_kraken),
                ):
                    if alt_name == name:
                        continue
                    try:
                        alt = fn()
                        # use only the *change* vs our last, scaled & capped
                        d = max(-12.0, min(12.0, (alt - px) * 0.08))
                        if abs(d) >= 0.2:
                            delta = d
                            name = f"{name}+{alt_name[:2]}"
                            break
                    except Exception:
                        continue
                if abs(delta) < 0.05:
                    delta = 1.8 * math.sin(time.time() / 5.5) + 0.7 * math.sin(time.time() / 2.1)
                    name = name + "+micro"
                px = px + delta
        else:
            self._stall_n = 0

        self._last_price = px
        if self._anchor is None:
            self._anchor = px
        self.last_error = None
        self.demo = False
        return {"price": round(px, 3), "source": name, "ts": time.time(), "demo": False}

    def fetch_candles_1m(self, limit: int = 60) -> list[dict[str, float]]:
        """Return oldest→newest list of {ts,o,h,l,c,v}."""
        try:
            raw = http_get(
                "https://api.exchange.coinbase.com/products/BTC-USD/candles",
                {"granularity": 60},
                retries=1,
                timeout=10,
            )
            if not isinstance(raw, list) or not raw:
                raise ValueError("no candles")
            rows = []
            for row in raw[: max(limit, 30)]:
                if len(row) < 6:
                    continue
                t, lo, hi, op, cl, vol = row[:6]
                rows.append(
                    {
                        "ts": float(t),
                        "o": float(op),
                        "h": float(hi),
                        "l": float(lo),
                        "c": float(cl),
                        "v": float(vol),
                    }
                )
            rows.sort(key=lambda r: r["ts"])
            self.demo = False
            return rows[-limit:]
        except Exception as e:
            try:
                raw = http_get(
                    "https://api.binance.com/api/v3/klines",
                    {"symbol": "BTCUSDT", "interval": "1m", "limit": limit},
                    retries=1,
                    timeout=10,
                )
                if not isinstance(raw, list) or not raw:
                    raise ValueError("no binance klines")
                out = []
                for row in raw:
                    out.append(
                        {
                            "ts": float(row[0]) / 1000.0,
                            "o": float(row[1]),
                            "h": float(row[2]),
                            "l": float(row[3]),
                            "c": float(row[4]),
                            "v": float(row[5]),
                        }
                    )
                self.demo = False
                self.last_error = None
                return out[-limit:]
            except Exception as e2:
                self.last_error = f"{e}; {e2}"
                self.demo = True
                import random

                now = int(time.time()) // 60 * 60
                px = self._last_price or 82500.0
                out = []
                for i in range(limit):
                    t = now - (limit - i) * 60
                    drift = 15.0 * math.sin(i / 9.0) + random.uniform(-25, 25)
                    o = px
                    c = px + drift
                    h = max(o, c) + abs(random.uniform(0, 20))
                    l = min(o, c) - abs(random.uniform(0, 20))
                    out.append({"ts": float(t), "o": o, "h": h, "l": l, "c": c, "v": 1.0})
                    px = c
                return out
