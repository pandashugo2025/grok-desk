"""Polymarket BTC Up/Down market spider (Gamma + CLOB + data-api)."""
from __future__ import annotations

import json
import time
from typing import Any

from .http_util import http_get

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
DATA = "https://data-api.polymarket.com"


def _parse_json_field(val: Any) -> Any:
    if isinstance(val, str):
        try:
            return json.loads(val)
        except json.JSONDecodeError:
            return val
    return val


class MarketSpider:
    def __init__(self) -> None:
        self.last_error: str | None = None
        self.demo = False
        self._last_market: dict[str, Any] | None = None

    def current_5m_window(self, now: float | None = None) -> int:
        t = int(now or time.time())
        return (t // 300) * 300

    def fetch_btc_updown_5m(self, window: int | None = None) -> dict[str, Any] | None:
        """Fetch current (or nearest) 5-minute BTC Up or Down event."""
        windows = []
        base = window if window is not None else self.current_5m_window()
        # Prefer current, then next, then previous (market may straddle)
        for w in (base, base + 300, base - 300, base + 600, base - 600):
            windows.append(w)

        last_err: Exception | None = None
        for w in windows:
            slug = f"btc-updown-5m-{w}"
            try:
                data = http_get(f"{GAMMA}/events", {"slug": slug})
                if not data:
                    continue
                event = data[0] if isinstance(data, list) else data
                markets = event.get("markets") or []
                if not markets:
                    continue
                m = markets[0]
                outcomes = _parse_json_field(m.get("outcomes")) or ["Up", "Down"]
                prices = _parse_json_field(m.get("outcomePrices")) or ["0.5", "0.5"]
                tokens = _parse_json_field(m.get("clobTokenIds")) or []
                up_px = float(prices[0]) if len(prices) > 0 else 0.5
                down_px = float(prices[1]) if len(prices) > 1 else 0.5
                end = event.get("endDate") or m.get("endDate")
                out = {
                    "slug": event.get("slug") or slug,
                    "title": event.get("title") or m.get("question"),
                    "window": w,
                    "active": bool(event.get("active")),
                    "closed": bool(event.get("closed")),
                    "end_date": end,
                    "condition_id": m.get("conditionId"),
                    "outcomes": outcomes,
                    "up_price": up_px,
                    "down_price": down_px,
                    "token_up": tokens[0] if len(tokens) > 0 else None,
                    "token_down": tokens[1] if len(tokens) > 1 else None,
                    "liquidity": float(m.get("liquidity") or event.get("liquidity") or 0),
                    "volume": float(m.get("volume") or 0),
                    "ts": time.time(),
                    "demo": False,
                }
                # Enrich with CLOB mid if possible
                if out["token_up"]:
                    try:
                        mid = http_get(f"{CLOB}/midpoint", {"token_id": out["token_up"]})
                        if isinstance(mid, dict) and mid.get("mid") is not None:
                            out["clob_mid_up"] = float(mid["mid"])
                    except Exception:
                        pass
                self.last_error = None
                self.demo = False
                self._last_market = out
                return out
            except Exception as e:
                last_err = e
                time.sleep(0.15)
                continue

        self.last_error = str(last_err) if last_err else "no market"
        return None

    def fetch_daily_updown(self) -> dict[str, Any] | None:
        try:
            data = http_get(
                f"{GAMMA}/events",
                {
                    "series_slug": "btc-up-or-down-daily",
                    "active": "true",
                    "closed": "false",
                    "limit": 3,
                },
            )
            if not data:
                return None
            event = data[0]
            markets = event.get("markets") or []
            m = markets[0] if markets else {}
            outcomes = _parse_json_field(m.get("outcomes")) or ["Up", "Down"]
            prices = _parse_json_field(m.get("outcomePrices")) or ["0.5", "0.5"]
            return {
                "slug": event.get("slug"),
                "title": event.get("title"),
                "end_date": event.get("endDate") or m.get("endDate"),
                "up_price": float(prices[0]) if prices else 0.5,
                "down_price": float(prices[1]) if len(prices) > 1 else 0.5,
                "outcomes": outcomes,
                "condition_id": m.get("conditionId"),
                "closed": bool(event.get("closed")),
                "demo": False,
            }
        except Exception as e:
            self.last_error = str(e)
            return None

    def fetch_recent_trades(self, condition_id: str, limit: int = 50) -> list[dict[str, Any]]:
        if not condition_id:
            return []
        try:
            data = http_get(f"{DATA}/trades", {"market": condition_id, "limit": limit})
            if not isinstance(data, list):
                return []
            trades = []
            for t in data:
                ts = t.get("timestamp") or t.get("createdAt") or t.get("match_time")
                try:
                    ts_f = float(ts)
                    # ms → s if needed
                    if ts_f > 1e12:
                        ts_f /= 1000.0
                except (TypeError, ValueError):
                    continue
                trades.append(
                    {
                        "ts": ts_f,
                        "side": t.get("side"),
                        "price": float(t.get("price") or 0),
                        "size": float(t.get("size") or 0),
                        "outcome": t.get("outcome") or t.get("asset") or "",
                    }
                )
            trades.sort(key=lambda x: x["ts"])
            return trades
        except Exception as e:
            self.last_error = str(e)
            return []

    def synthetic_market(self, spot: float) -> dict[str, Any]:
        """Demo fallback: fake 5m window with prices drifting from spot noise."""
        import math

        w = self.current_5m_window()
        phase = math.sin(time.time() / 11.0)
        up = max(0.05, min(0.95, 0.52 + 0.18 * phase))
        end = w + 300
        self.demo = True
        out = {
            "slug": f"btc-updown-5m-{w}-DEMO",
            "title": f"[DEMO] Bitcoin Up or Down — window {w}",
            "window": w,
            "active": True,
            "closed": False,
            "end_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end)),
            "condition_id": None,
            "outcomes": ["Up", "Down"],
            "up_price": round(up, 3),
            "down_price": round(1.0 - up, 3),
            "token_up": None,
            "token_down": None,
            "liquidity": 10000.0,
            "volume": 0.0,
            "ts": time.time(),
            "demo": True,
            "spot_ref": spot,
        }
        self._last_market = out
        return out


    def fetch_book(self, token_id: str | None, depth: int = 12) -> dict:
        """Best-effort CLOB book for imbalance gauge. Empty if unavailable."""
        if not token_id:
            return {"bids": [], "asks": [], "available": False}
        try:
            data = http_get(f"{CLOB}/book", {"token_id": token_id})
            if not isinstance(data, dict):
                return {"bids": [], "asks": [], "available": False}
            def _lvl(rows):
                out = []
                for r in (rows or [])[:depth]:
                    if isinstance(r, dict):
                        out.append([float(r.get("price") or 0), float(r.get("size") or 0)])
                    elif isinstance(r, (list, tuple)) and len(r) >= 2:
                        out.append([float(r[0]), float(r[1])])
                return out
            bids = _lvl(data.get("bids") or data.get("buys"))
            asks = _lvl(data.get("asks") or data.get("sells"))
            return {"bids": bids, "asks": asks, "available": bool(bids or asks)}
        except Exception as e:
            self.last_error = str(e)
            return {"bids": [], "asks": [], "available": False}

    def snapshot(self, spot_price: float | None = None) -> dict[str, Any]:
        m = self.fetch_btc_updown_5m()
        if m is None:
            m = self.synthetic_market(spot_price or 82500.0)
        daily = self.fetch_daily_updown()
        trades: list[dict[str, Any]] = []
        if m.get("condition_id") and not m.get("demo"):
            trades = self.fetch_recent_trades(m["condition_id"], limit=40)
        if not trades:
            # Synthetic tape so Hawkes still has timestamps in demo
            now = time.time()
            import random

            for i in range(25):
                trades.append(
                    {
                        "ts": now - random.uniform(0, 280),
                        "side": random.choice(["BUY", "SELL"]),
                        "price": m["up_price"] + random.uniform(-0.05, 0.05),
                        "size": random.uniform(1, 80),
                        "outcome": random.choice(["Up", "Down"]),
                    }
                )
            trades.sort(key=lambda x: x["ts"])
            if not m.get("demo"):
                # live market but empty tape — mark soft demo for trades only
                pass
        end_ts = None
        if m.get("end_date"):
            try:
                from datetime import datetime, timezone

                end_ts = datetime.fromisoformat(
                    m["end_date"].replace("Z", "+00:00")
                ).timestamp()
            except Exception:
                end_ts = (m.get("window") or self.current_5m_window()) + 300
        else:
            end_ts = (m.get("window") or self.current_5m_window()) + 300

        book = {"bids": [], "asks": [], "available": False}
        if m.get("token_up") and not m.get("demo"):
            book = self.fetch_book(m.get("token_up"))
        return {
            "market": m,
            "daily": daily,
            "trades": trades,
            "book": book,
            "end_ts": end_ts,
            "seconds_to_resolution": max(0.0, end_ts - time.time()),
            "demo": bool(m.get("demo")),
            "error": self.last_error,
            "ts": time.time(),
        }
