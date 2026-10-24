#!/usr/bin/env python3
"""
GROK DESK — paper-only Polymarket multi-agent simulator.

Starts:
  1) background spider + signal + swarm loop
  2) HTTP server serving ui/ + /api/state

NO private keys, NO CLOB order signing, NO live posts.
"""
from __future__ import annotations

import argparse
import os
import queue
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from agents.swarm import Swarm  # noqa: E402
from signals.engine import SignalEngine  # noqa: E402
from spider.market import MarketSpider  # noqa: E402
from spider.spot import SpotSpider  # noqa: E402
from spider.wallets import fetch_wallet_recent, list_wallets, maybe_refresh_spider  # noqa: E402
from spider.watch_live import (  # noqa: E402
    ensure_poller,
    set_watch,
    subscribe,
    unsubscribe,
    watch_status,
)

STATE_LOCK = threading.Lock()
_WATCH_STOP = threading.Event()
STATE: dict[str, Any] = {
    "boot_ts": time.time(),
    "cycle": 0,
    "demo": True,
    "agents_alive": False,
    "signal": {},
    "market": {},
    "spot": {},
    "portfolio": {},
    "command_stack": [],
    "trace_tail": [],
    "agents": {},
    "handoffs": [],
    "live_wire": [],
    "candles": [],
    "book": {},
    "error": None,
    "paper_only": True,
    "disclaimer": "PAPER / SIMULATION — no live orders",
}

HK_LABEL = "Asia/Hong_Kong (UTC+8)"


def engine_loop(interval: float, size_usdc: float, stop: threading.Event) -> None:
    market_sp = MarketSpider()
    spot_sp = SpotSpider()
    signals = SignalEngine(last_minute_s=120.0)
    swarm = Swarm()

    _orig = swarm.portfolio.apply_signal

    def _apply(signal, market, size_usdc=size_usdc):  # type: ignore
        return _orig(signal, market, size_usdc=size_usdc)

    swarm.portfolio.apply_signal = _apply  # type: ignore
    STATE["agents_alive"] = True

    while not stop.is_set():
        try:
            spot = spot_sp.fetch_spot()
            candles = spot_sp.fetch_candles_1m(limit=60)
            snap = market_sp.snapshot(spot_price=float(spot.get("price") or 82500))
            m = snap["market"]
            book = snap.get("book") or {}
            sig = signals.evaluate(
                trades=snap.get("trades") or [],
                candles=candles,
                up_price=float(m.get("up_price") or 0.5),
                down_price=float(m.get("down_price") or 0.5),
                seconds_to_resolution=float(snap.get("seconds_to_resolution") or 0),
                spot=float(spot.get("price") or 0) or None,
                market=m,
                book=book,
            )
            result = swarm.run_cycle(sig, m, spot)
            demo = bool(snap.get("demo") or spot.get("demo"))
            # Compact candles for tape chart (last 40)
            candle_payload = [
                {"ts": c["ts"], "o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "v": c["v"]}
                for c in candles[-40:]
            ]
            payload = {
                "cycle": result["cycle"],
                "demo": demo,
                "agents_alive": True,
                "signal": sig,
                "market": m,
                "daily": snap.get("daily"),
                "spot": spot,
                "book": book,
                "candles": candle_payload,
                "portfolio": result["portfolio"],
                "command_stack": result["command_stack"],
                "trace_tail": result["trace_tail"],
                "handoffs": result.get("handoffs") or [],
                "agents": result.get("agents") or {},
                "agent_order": result.get("agent_order") or [],
                "agent_colors": result.get("agent_colors") or {},
                "live_wire": result.get("live_wire") or [],
                "seconds_to_resolution": snap.get("seconds_to_resolution"),
                "error": snap.get("error") or spot_sp.last_error,
                "ts": time.time(),
                "tz": HK_LABEL,
                "paper_only": True,
                "disclaimer": "PAPER / SIMULATION — no live orders",
            }
            with STATE_LOCK:
                STATE.update(payload)
            (ROOT / "state" / "latest.json").write_text(
                json.dumps(STATE, indent=2, default=str), encoding="utf-8"
            )
            log_line = {
                "ts": payload["ts"],
                "cycle": payload["cycle"],
                "action": sig.get("action"),
                "pnl_total": result["portfolio"].get("pnl_total"),
                "demo": demo,
            }
            with (ROOT / "output" / "cycles.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(log_line) + "\n")
        except Exception as e:
            with STATE_LOCK:
                STATE["error"] = repr(e)
        stop.wait(interval)

    with STATE_LOCK:
        STATE["agents_alive"] = False


class DeskHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "ui"), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        if args and str(args[1]).startswith("4"):
            super().log_message(fmt, *args)

    def _json(self, payload: Any, code: int = 200) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parsed.query
        from urllib.parse import parse_qs

        params = {k: (v[0] if v else "") for k, v in parse_qs(qs).items()}

        if path in ("/health", "/api/health", "/healthz", "/api/healthz"):
            # Lightweight liveness for Render health checks + client wake probes.
            with STATE_LOCK:
                alive = bool(STATE.get("agents_alive"))
                cycle = int(STATE.get("cycle") or 0)
                boot = STATE.get("boot_ts")
                err = STATE.get("error")
            self._json({
                "ok": True,
                "service": "grok-desk",
                "paper_only": True,
                "agents_alive": alive,
                "cycle": cycle,
                "boot_ts": boot,
                "uptime_s": round(time.time() - float(boot or time.time()), 1),
                "error": err,
                "tz": HK_LABEL,
            })
            return

        if path in ("/api/state", "/api/state.json"):
            with STATE_LOCK:
                payload = dict(STATE)
            self._json(payload)
            return

        if path in ("/api/wallets", "/api/wallets.json"):
            try:
                min_pnl = params.get("min_pnl")
                payload = list_wallets(
                    strategy=params.get("strategy") or None,
                    min_pnl=float(min_pnl) if min_pnl not in (None, "") else None,
                    q=params.get("q") or None,
                    limit=int(params.get("limit") or 100),
                )
                self._json(payload)
            except Exception as e:
                self._json({"error": repr(e), "paper_only": True, "wallets": []}, 500)
            return


        if path in ("/api/wallets/stream",):
            self._sse_wallets()
            return

        if path in ("/api/wallets/watch", "/api/wallets/watch.json") and self.command == "GET":
            self._json(watch_status())
            return

        if path in ("/api/wallets/refresh", "/api/wallets/refresh.json"):
            try:
                info = maybe_refresh_spider(force=True)
                # also return fresh list meta
                meta = list_wallets(limit=1)
                self._json({
                    "paper_only": True,
                    "refresh": info,
                    "csv_age_hours": meta.get("csv_age_hours"),
                    "csv_mtime": meta.get("csv_mtime"),
                    "total_in_csv": meta.get("total_in_csv"),
                    "source_csv": meta.get("source_csv"),
                    "ts": meta.get("ts"),
                    "disclaimer": "PAPER — spider refresh kicked; no trading",
                })
            except Exception as e:
                self._json({"error": repr(e), "paper_only": True}, 500)
            return

        if path.startswith("/api/wallets/") and path.endswith("/recent"):
            mid = path[len("/api/wallets/") : -len("/recent")]
            addr = mid.strip("/").split("/")[0]
            try:
                limit = int(params.get("limit") or 40)
                nocache = str(params.get("nocache") or "").lower() in ("1", "true", "yes")
                since_raw = params.get("since") or ""
                since = int(since_raw) if since_raw not in ("", None) else None
                self._json(fetch_wallet_recent(addr, limit=limit, nocache=nocache, since=since))
            except Exception as e:
                self._json({"error": repr(e), "paper_only": True, "address": addr}, 500)
            return

        if path in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()


    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}
        if path in ("/api/wallets/watch", "/api/wallets/watch.json"):
            try:
                addrs = body.get("addresses") or body.get("watch") or []
                if isinstance(addrs, str):
                    addrs = [addrs]
                focus = body.get("focus")
                interval = body.get("interval") or body.get("interval_s")
                replace = bool(body.get("replace"))
                ensure_poller(_WATCH_STOP)
                payload = set_watch(
                    addresses=list(addrs) if addrs else None,
                    focus=focus,
                    interval=float(interval) if interval not in (None, "") else None,
                    replace=replace,
                )
                self._json(payload)
            except Exception as e:
                self._json({"error": repr(e), "paper_only": True}, 500)
            return
        self._json({"error": "not_found", "paper_only": True}, 404)

    def _sse_wallets(self) -> None:
        ensure_poller(_WATCH_STOP)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = subscribe()
        try:
            hello = json.dumps({"type": "hello", "paper_only": True, "watch": watch_status()}, default=str)
            self.wfile.write(f"event: hello\ndata: {hello}\n\n".encode("utf-8"))
            self.wfile.flush()
            while not _WATCH_STOP.is_set():
                try:
                    msg = q.get(timeout=12.0)
                except queue.Empty:
                    try:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    except Exception:
                        break
                    continue
                try:
                    data = json.dumps(msg, default=str)
                    et = msg.get("type") or "message"
                    self.wfile.write(f"event: {et}\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except Exception:
                    break
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            unsubscribe(q)


def pick_port(preferred: int) -> int:
    import socket

    for port in [preferred, preferred + 1, preferred + 2, 8765, 8766, 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1] if port == 0 else port
            except OSError:
                continue
    return preferred


def main() -> None:
    ap = argparse.ArgumentParser(description="GROK DESK paper simulator")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--interval", type=float, default=3.0, help="seconds between cycles")
    ap.add_argument("--size", type=float, default=25.0, help="paper USDC per entry")
    # Render (and similar) set PORT; bind all interfaces by default in that case.
    # Local default stays 127.0.0.1; always overrideable via --host 0.0.0.0.
    default_host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    ap.add_argument("--host", default=default_host)
    args = ap.parse_args()

    if os.environ.get("PORT"):
        port = int(os.environ["PORT"])
    else:
        port = pick_port(args.port)
    stop = threading.Event()
    t = threading.Thread(
        target=engine_loop, args=(args.interval, args.size, stop), daemon=True
    )
    t.start()
    ensure_poller(_WATCH_STOP)

    server = ThreadingHTTPServer((args.host, port), DeskHandler)
    url = f"http://{args.host}:{port}/"
    print("=" * 60, flush=True)
    print("GROK DESK — PAPER / SIMULATION ONLY", flush=True)
    print(f"UI:     {url}", flush=True)
    print(f"API:    {url}health | api/state | wallets | watch | stream", flush=True)
    print(f"State:  {ROOT / 'state' / 'latest.json'}", flush=True)
    print(f"Cycles: {ROOT / 'output' / 'cycles.jsonl'}", flush=True)
    print(f"Interval: {args.interval}s | size: ${args.size} paper", flush=True)
    print("No private keys. No live CLOB orders.", flush=True)
    print("=" * 60, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        stop.set()
        _WATCH_STOP.set()
        server.server_close()


if __name__ == "__main__":
    main()
