"""Virtual USDC portfolio — simulate fills at mid ± slip. No keys, no CLOB posts."""
from __future__ import annotations

import time
import uuid
from typing import Any


class PaperPortfolio:
    def __init__(self, starting_usdc: float = 10_000.0, slip: float = 0.01) -> None:
        self.cash = float(starting_usdc)
        self.starting = float(starting_usdc)
        self.slip = slip
        self.position: dict[str, Any] | None = None  # {side, shares, entry, market}
        self.realized_pnl = 0.0
        self.trades: list[dict[str, Any]] = []
        self.equity_curve: list[dict[str, float]] = []
        self._seed_equity_curve()

    def _seed_equity_curve(self) -> None:
        """Prefill curve from recorded paper cycles so UI chart is not flat on boot."""
        import json
        from pathlib import Path

        log = Path(__file__).resolve().parent.parent / "output" / "cycles.jsonl"
        if not log.exists():
            return
        pts: list[dict[str, float]] = []
        try:
            with log.open("r", encoding="utf-8") as f:
                # read tail without loading entire multi-MB file into memory twice
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 400_000))
                raw = f.read()
            lines = raw.splitlines()
            if size > 400_000 and lines:
                lines = lines[1:]  # drop partial first line
            for line in lines[-400:]:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                pnl = row.get("pnl_total")
                ts = row.get("ts")
                if pnl is None or ts is None:
                    continue
                pts.append({"ts": float(ts), "equity": round(self.starting + float(pnl), 4)})
            # downsample to ~120 pts of real recorded paper equity
            if len(pts) > 120:
                step = max(1, len(pts) // 120)
                pts = pts[::step][-120:]
            if pts:
                self.equity_curve = pts[-120:]
        except Exception:
            return

    def mark_equity(self, up_price: float, down_price: float) -> float:
        eq = self.cash
        if self.position:
            px = up_price if self.position["side"] == "UP" else down_price
            eq += self.position["shares"] * px
        self.equity_curve.append({"ts": time.time(), "equity": round(eq, 4)})
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]
        return eq

    def apply_signal(
        self,
        signal: dict[str, Any],
        market: dict[str, Any],
        *,
        size_usdc: float = 25.0,
    ) -> dict[str, Any] | None:
        """
        Paper fill: BUY_UP / BUY_DOWN opens (or flips); HOLD may close near resolution.
        """
        action = signal.get("action", "HOLD")
        up = float(signal.get("up_price") or market.get("up_price") or 0.5)
        down = float(signal.get("down_price") or market.get("down_price") or 0.5)
        ttr = float(signal.get("seconds_to_resolution") or 999)

        fill_event: dict[str, Any] | None = None

        # Close near resolution or on flip
        if self.position and (ttr < 8 or action == "HOLD" and ttr < 25):
            fill_event = self._close(up, down, reason="resolve_or_fade")
        elif self.position and action in ("BUY_UP", "BUY_DOWN"):
            want = "UP" if action == "BUY_UP" else "DOWN"
            if want != self.position["side"]:
                fill_event = self._close(up, down, reason="flip")
                opened = self._open(want, up, down, size_usdc, market)
                if opened:
                    fill_event = opened
        elif action in ("BUY_UP", "BUY_DOWN") and self.position is None:
            want = "UP" if action == "BUY_UP" else "DOWN"
            # Only size if confidence decent and cash available
            conf = float(signal.get("confidence") or 0)
            sized = size_usdc * (0.6 + 0.8 * conf)
            fill_event = self._open(want, up, down, sized, market)

        self.mark_equity(up, down)
        return fill_event

    def _open(
        self,
        side: str,
        up: float,
        down: float,
        size_usdc: float,
        market: dict[str, Any],
    ) -> dict[str, Any] | None:
        mid = up if side == "UP" else down
        px = min(0.99, max(0.01, mid + self.slip))
        if self.cash < size_usdc or size_usdc < 1:
            return None
        shares = size_usdc / px
        self.cash -= size_usdc
        self.position = {
            "side": side,
            "shares": shares,
            "entry": px,
            "cost": size_usdc,
            "market": market.get("slug"),
            "opened_at": time.time(),
        }
        ev = {
            "id": str(uuid.uuid4())[:8],
            "ts": time.time(),
            "type": "OPEN",
            "side": side,
            "price": round(px, 4),
            "shares": round(shares, 4),
            "cost": round(size_usdc, 2),
            "market": market.get("slug"),
            "paper": True,
        }
        self.trades.append(ev)
        return ev

    def _close(self, up: float, down: float, reason: str) -> dict[str, Any] | None:
        if not self.position:
            return None
        side = self.position["side"]
        mid = up if side == "UP" else down
        px = min(0.99, max(0.01, mid - self.slip))
        proceeds = self.position["shares"] * px
        pnl = proceeds - self.position["cost"]
        self.cash += proceeds
        self.realized_pnl += pnl
        ev = {
            "id": str(uuid.uuid4())[:8],
            "ts": time.time(),
            "type": "CLOSE",
            "side": side,
            "price": round(px, 4),
            "shares": round(self.position["shares"], 4),
            "pnl": round(pnl, 4),
            "reason": reason,
            "market": self.position.get("market"),
            "paper": True,
        }
        self.trades.append(ev)
        self.position = None
        return ev

    def summary(self, up_price: float = 0.5, down_price: float = 0.5) -> dict[str, Any]:
        eq = self.mark_equity(up_price, down_price)
        return {
            "cash": round(self.cash, 2),
            "equity": round(eq, 2),
            "realized_pnl": round(self.realized_pnl, 2),
            "unrealized": round(eq - self.cash, 2) if self.position else 0.0,
            "pnl_total": round(eq - self.starting, 2),
            "starting": self.starting,
            "position": self.position,
            "n_trades": len(self.trades),
            "recent_trades": self.trades[-12:],
            "equity_curve": self.equity_curve[-120:],
        }
