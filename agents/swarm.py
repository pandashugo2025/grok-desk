"""Multi-agent handoff: SPOTTER → PRIOR → EDGE → KELLY → TAKER → CLOSER."""
from __future__ import annotations

import time
from typing import Any

from .paper import PaperPortfolio

# Full desk roster matching reference UI
AGENT_IDS = ("EDGE", "CLOSER", "PRIOR", "TAKER", "SPOTTER", "KELLY")
AGENT_COLORS = {
    "EDGE": "#ff4dcf",
    "CLOSER": "#ff8a3d",
    "PRIOR": "#c9a227",
    "TAKER": "#4d8cff",
    "SPOTTER": "#2dd4bf",
    "KELLY": "#a855f7",
}


class Swarm:
    def __init__(self, portfolio: PaperPortfolio | None = None) -> None:
        self.portfolio = portfolio or PaperPortfolio()
        self.trace: list[dict[str, Any]] = []
        self.command_stack: list[dict[str, Any]] = []
        self.handoffs: list[dict[str, Any]] = []
        self.live_wire: list[str] = []
        self.cycle = 0
        self.last_signal: dict[str, Any] | None = None
        self.agent_status: dict[str, dict[str, Any]] = {
            a: {"status": "QUEUED", "detail": "", "since": time.time(), "color": AGENT_COLORS[a]}
            for a in AGENT_IDS
        }
        self._stage_t0 = time.time()

    def _set_agent(self, agent: str, status: str, detail: str = "") -> None:
        self.agent_status[agent] = {
            "status": status,
            "detail": detail,
            "since": time.time(),
            "color": AGENT_COLORS.get(agent, "#fff"),
            "elapsed": 0,
        }

    def _push(self, agent: str, msg: str, payload: dict[str, Any] | None = None) -> None:
        row = {
            "ts": time.time(),
            "agent": agent,
            "msg": msg,
            "cycle": self.cycle,
            "payload": payload or {},
        }
        self.trace.append(row)
        self.command_stack.append(row)
        if len(self.trace) > 200:
            self.trace = self.trace[-200:]
        if len(self.command_stack) > 40:
            self.command_stack = self.command_stack[-40:]
        wire = f"{agent} · {msg}"
        self.live_wire.append(wire)
        if len(self.live_wire) > 24:
            self.live_wire = self.live_wire[-24:]

    def _handoff(self, frm: str, to: str, note: str = "") -> None:
        self.handoffs.append(
            {"ts": time.time(), "from": frm, "to": to, "note": note, "cycle": self.cycle}
        )
        if len(self.handoffs) > 40:
            self.handoffs = self.handoffs[-40:]
        self._push(to, f"handoff {frm} → {to}" + (f" · {note}" if note else ""), {"from": frm})

    def run_cycle(
        self,
        signal: dict[str, Any],
        market: dict[str, Any],
        spot: dict[str, Any],
    ) -> dict[str, Any]:
        self.cycle += 1
        self.last_signal = signal
        now = time.time()
        ttr = float(signal.get("seconds_to_resolution") or 0)
        action = signal.get("action", "HOLD")
        conf = float(signal.get("confidence") or 0)

        # Reset roster to QUEUED then activate pipeline stages
        for a in AGENT_IDS:
            self._set_agent(a, "QUEUED", "await")

        # SPOTTER — observe tape / book / spot
        self._set_agent("SPOTTER", "RUNNING", "scan tape")
        self._push(
            "SPOTTER",
            f"tape λ={signal.get('intensity')} flow={signal.get('flow')} "
            f"spot={spot.get('price')} up={signal.get('up_price')} ttr={ttr:.0f}s",
            {"intensity": signal.get("intensity"), "spot": spot.get("price")},
        )
        self._set_agent("SPOTTER", "DONE", "fed prior")
        self._handoff("SPOTTER", "PRIOR", "features")

        # PRIOR — belief update
        self._set_agent("PRIOR", "RUNNING", "belief")
        dmi = signal.get("dmi") or {}
        self._push(
            "PRIOR",
            f"bias={signal.get('bias')} ADX={dmi.get('adx')} "
            f"+DI={dmi.get('plus_di')} -DI={dmi.get('minus_di')} "
            f"last_min={signal.get('last_minute_factor')}",
            {"bias": signal.get("bias"), "dmi": dmi},
        )
        self._set_agent("PRIOR", "DONE", "prior locked")
        self._handoff("PRIOR", "EDGE", "score")

        # EDGE — combine last-minute + hawkes edge score
        self._set_agent("EDGE", "RUNNING", "edge score")
        self._push(
            "EDGE",
            f"conf={conf:.3f} λn={signal.get('intensity_n')} "
            f"lm={signal.get('last_minute_factor')} → {action}",
            {"action": action, "confidence": conf},
        )
        if action != "HOLD":
            self._set_agent("EDGE", "RUNNING", action)
        else:
            self._set_agent("EDGE", "DONE", "no edge")
        self._handoff("EDGE", "KELLY", "size")

        # KELLY — paper size fraction from confidence
        self._set_agent("KELLY", "RUNNING", "size")
        kelly_f = round(0.15 + 0.55 * conf, 3)
        self._push(
            "KELLY",
            f"paper kelly≈{kelly_f} conf={conf:.3f} (sim fraction only)",
            {"kelly_f": kelly_f},
        )
        self._set_agent("KELLY", "DONE", f"f={kelly_f}")
        self._handoff("KELLY", "TAKER", "route")

        fill = None

        # TAKER — paper entry
        if action in ("BUY_UP", "BUY_DOWN"):
            self._set_agent("TAKER", "RUNNING", action)
            self._push(
                "TAKER",
                f"PAPER {action} conf={conf:.3f} ttr={ttr:.0f}s",
                {"action": action},
            )
            fill = self.portfolio.apply_signal(signal, market)
            if fill and fill.get("type") == "OPEN":
                self._push(
                    "TAKER",
                    f"filled {fill['side']} @ {fill['price']} × {fill['shares']} (PAPER)",
                    fill,
                )
                self._set_agent("TAKER", "DONE", f"fill {fill['side']}")
                self._handoff("TAKER", "CLOSER", "manage")
            else:
                self._set_agent("TAKER", "DONE", "no fill")
        else:
            reason = "no edge"
            if conf < 0.3:
                reason = "low confidence"
            elif abs(float(signal.get("bias") or 0)) < 0.10:
                reason = "bias below threshold"
            if float(dmi.get("adx") or 0) < 15 and float(signal.get("last_minute_factor") or 0) < 0.55:
                reason = "weak ADX / early window"
            self._set_agent("TAKER", "QUEUED", reason)
            self._push("TAKER", f"HOLD — {reason}", {"action": "HOLD"})
            fill = self.portfolio.apply_signal(signal, market)

        # CLOSER — manage / log exit
        if fill and fill.get("type") == "CLOSE":
            self._set_agent("CLOSER", "RUNNING", "exit")
            self._push(
                "CLOSER",
                f"closed {fill['side']} pnl={fill.get('pnl')} reason={fill.get('reason')}",
                fill,
            )
            self._set_agent("CLOSER", "DONE", f"pnl={fill.get('pnl')}")
        elif self.portfolio.position:
            pos = self.portfolio.position
            self._set_agent("CLOSER", "RUNNING", f"watch {pos['side']}")
            self._push(
                "CLOSER",
                f"watching {pos['side']} entry={pos['entry']} ttr={ttr:.0f}s",
                {"position": pos},
            )
        else:
            self._set_agent("CLOSER", "QUEUED", "flat")
            self._push("CLOSER", "flat — awaiting next edge", {})

        # Keep EDGE highlighted when actively signaling
        if action in ("BUY_UP", "BUY_DOWN") and self.portfolio.position:
            self._set_agent("EDGE", "RUNNING", action)

        # Elapsed cosmetics
        for a, st in self.agent_status.items():
            st["elapsed"] = round(now - st.get("since", now), 1)

        up = float(signal.get("up_price") or 0.5)
        down = float(signal.get("down_price") or 0.5)
        summary = self.portfolio.summary(up, down)

        # Win rate / max DD from equity curve (paper)
        wins = sum(1 for t in self.portfolio.trades if t.get("type") == "CLOSE" and (t.get("pnl") or 0) > 0)
        closes = sum(1 for t in self.portfolio.trades if t.get("type") == "CLOSE")
        win_rate = (wins / closes * 100.0) if closes else 0.0
        eq_curve = summary.get("equity_curve") or []
        peak = summary.get("starting", 10000)
        max_dd = 0.0
        for pt in eq_curve:
            e = float(pt.get("equity") or peak)
            peak = max(peak, e)
            if peak > 0:
                max_dd = max(max_dd, (peak - e) / peak * 100.0)

        summary["win_rate"] = round(win_rate, 1)
        summary["max_dd_pct"] = round(max_dd, 2)
        summary["n_closes"] = closes

        return {
            "cycle": self.cycle,
            "signal": signal,
            "fill": fill,
            "portfolio": summary,
            "trace_tail": self.trace[-16:],
            "command_stack": list(reversed(self.command_stack[-14:])),
            "handoffs": list(reversed(self.handoffs[-12:])),
            "agents": dict(self.agent_status),
            "live_wire": list(self.live_wire[-16:]),
            "agent_order": list(AGENT_IDS),
            "agent_colors": dict(AGENT_COLORS),
        }
