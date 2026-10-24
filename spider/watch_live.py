"""Near-realtime paper watch: poll public activity for watched wallets + SSE fanout.

No keys, no CLOB. Stdlib only.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from typing import Any

from spider.http_util import http_get
from spider.wallets import (
    CACHE_DIR,
    DATA_API,
    _cache_path,
    _norm_activity_item,
    _write_activity_cache,
    fetch_wallet_recent,
)

_lock = threading.Lock()
_watched: set[str] = set()
_focus: str | None = None
_interval_s = 15.0
_newest_ts: dict[str, int] = {}
_last_poll: dict[str, float] = {}
_subscribers: list[queue.Queue] = []
_poller_started = False
_status: dict[str, Any] = {
    "running": False,
    "last_cycle_ts": None,
    "last_error": None,
    "polls": 0,
    "events": 0,
}


def _norm_addr(a: str | None) -> str | None:
    if not a:
        return None
    a = a.strip().lower()
    if not a.startswith("0x") or len(a) < 10:
        return None
    return a


def set_watch(
    *,
    addresses: list[str] | None = None,
    focus: str | None = None,
    interval: float | None = None,
    replace: bool = False,
) -> dict[str, Any]:
    global _focus, _interval_s
    with _lock:
        if interval is not None:
            try:
                iv = float(interval)
                if iv < 5:
                    iv = 5.0
                if iv > 120:
                    iv = 120.0
                _interval_s = iv
            except (TypeError, ValueError):
                pass
        if replace and addresses is not None:
            _watched.clear()
        if addresses:
            for a in addresses:
                na = _norm_addr(a)
                if na:
                    _watched.add(na)
        if focus is not None:
            if focus == "" or focus.lower() == "null":
                _focus = None
            else:
                nf = _norm_addr(focus)
                _focus = nf
                if nf:
                    _watched.add(nf)
        # drop empty
        addrs = sorted(_watched)
    return watch_status()


def unwatch(address: str) -> dict[str, Any]:
    na = _norm_addr(address)
    with _lock:
        if na and na in _watched:
            _watched.discard(na)
        global _focus
        if _focus == na:
            _focus = None
    return watch_status()


def watch_status() -> dict[str, Any]:
    with _lock:
        return {
            "paper_only": True,
            "watched": sorted(_watched),
            "focus": _focus,
            "interval_s": _interval_s,
            "newest_ts": dict(_newest_ts),
            "subscribers": len(_subscribers),
            "status": dict(_status),
            "disclaimer": "PAPER near-realtime — public GETs only",
        }


def subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=64)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    with _lock:
        if q in _subscribers:
            _subscribers.remove(q)


def _broadcast(event: dict[str, Any]) -> None:
    with _lock:
        subs = list(_subscribers)
        _status["events"] = int(_status.get("events") or 0) + 1
    dead: list[queue.Queue] = []
    for q in subs:
        try:
            q.put_nowait(event)
        except queue.Full:
            try:
                q.get_nowait()
            except queue.Empty:
                pass
            try:
                q.put_nowait(event)
            except queue.Full:
                dead.append(q)
    for q in dead:
        unsubscribe(q)


def _item_key(it: dict[str, Any]) -> str:
    return f"{it.get('tx') or ''}|{it.get('timestamp') or 0}|{it.get('type') or ''}|{it.get('side') or ''}|{it.get('title') or ''}"


def _merge_cache(addr: str, new_activity: list[dict[str, Any]], new_trades: list[dict[str, Any]]) -> tuple[int, int]:
    """Merge incremental items into disk cache. Returns (newest_ts, new_count)."""
    path = _cache_path(addr)
    base: dict[str, Any] = {}
    if path.exists():
        try:
            base = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            base = {}
    old_act = list(base.get("activity") or [])
    old_tr = list(base.get("trades") or [])
    seen_a = {_item_key(x) for x in old_act}
    seen_t = {_item_key(x) for x in old_tr}
    added = 0
    for it in reversed(new_activity):  # oldest first when prepending later
        k = _item_key(it)
        if k not in seen_a:
            old_act.insert(0, it)
            seen_a.add(k)
            added += 1
    for it in reversed(new_trades):
        k = _item_key(it)
        if k not in seen_t:
            old_tr.insert(0, it)
            seen_t.add(k)
            added += 1
    # cap
    old_act = old_act[:80]
    old_tr = old_tr[:80]
    newest = 0
    for it in old_act + old_tr:
        newest = max(newest, int(it.get("timestamp") or 0))
    base["activity"] = old_act
    base["trades"] = old_tr
    base["address"] = addr
    base["paper_only"] = True
    base["newest_ts"] = newest
    base["ts"] = time.time()
    _write_activity_cache(addr, base)
    return newest, added


def poll_wallet_public(addr: str, *, since: int | None = None) -> dict[str, Any]:
    """Light poll: activity (+ trades) only. No gamma profile."""
    addr = addr.strip().lower()
    activity: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    err: str | None = None
    try:
        raw = http_get(f"{DATA_API}/activity", {"user": addr, "limit": 25})
        if isinstance(raw, list):
            activity = [_norm_activity_item(x) for x in raw if isinstance(x, dict)]
        elif isinstance(raw, dict):
            batch = raw.get("data") or raw.get("activities") or []
            activity = [_norm_activity_item(x) for x in batch if isinstance(x, dict)]
    except Exception as e:
        err = f"activity: {e!r}"
    try:
        raw_t = http_get(f"{DATA_API}/trades", {"user": addr, "limit": 15})
        if isinstance(raw_t, list):
            trades = [
                _norm_activity_item({**x, "type": x.get("type") or "TRADE"})
                for x in raw_t
                if isinstance(x, dict)
            ]
        elif isinstance(raw_t, dict):
            batch = raw_t.get("data") or []
            trades = [
                _norm_activity_item({**x, "type": x.get("type") or "TRADE"})
                for x in batch
                if isinstance(x, dict)
            ]
    except Exception as e:
        if not err:
            err = f"trades: {e!r}"

    if since:
        since_i = int(since)
        activity = [x for x in activity if int(x.get("timestamp") or 0) > since_i]
        trades = [x for x in trades if int(x.get("timestamp") or 0) > since_i]

    return {
        "address": addr,
        "activity": activity,
        "trades": trades,
        "error": err,
        "paper_only": True,
    }


def _poll_cycle() -> None:
    with _lock:
        addrs = list(_watched)
        interval = _interval_s
        known = dict(_newest_ts)
    if not addrs:
        with _lock:
            _status["running"] = True
            _status["last_cycle_ts"] = time.time()
        return

    for addr in addrs:
        since = known.get(addr) or 0
        # first poll: seed newest without broadcasting flood
        first = addr not in known
        try:
            if first:
                # seed from cache or one full fetch
                payload = fetch_wallet_recent(addr, limit=30, nocache=False)
                acts = payload.get("activity") or []
                trs = payload.get("trades") or []
                newest = 0
                for it in acts + trs:
                    newest = max(newest, int(it.get("timestamp") or 0))
                with _lock:
                    _newest_ts[addr] = newest
                    _last_poll[addr] = time.time()
                    _status["polls"] = int(_status.get("polls") or 0) + 1
                continue

            light = poll_wallet_public(addr, since=since if since else None)
            if light.get("error") and not (light.get("activity") or light.get("trades")):
                with _lock:
                    _status["last_error"] = light["error"]
                continue
            new_a = light.get("activity") or []
            new_t = light.get("trades") or []
            # if since filter empty but API returned same head, detect by newest
            if not since:
                new_a, new_t = [], []
            newest, added = _merge_cache(addr, new_a, new_t)
            # also compute newest from returned even if merge added 0
            for it in new_a + new_t:
                newest = max(newest, int(it.get("timestamp") or 0))
            with _lock:
                prev = int(_newest_ts.get(addr) or 0)
                if newest > prev:
                    _newest_ts[addr] = newest
                _last_poll[addr] = time.time()
                _status["polls"] = int(_status.get("polls") or 0) + 1
                cur_newest = int(_newest_ts.get(addr) or newest or prev)
            if added > 0 or (newest > since):
                count = max(added, len(new_a) + len(new_t))
                if count > 0:
                    _broadcast(
                        {
                            "type": "activity",
                            "address": addr,
                            "newest_ts": cur_newest,
                            "count": count,
                            "ts": time.time(),
                            "paper_only": True,
                        }
                    )
        except Exception as e:
            with _lock:
                _status["last_error"] = repr(e)
        time.sleep(0.2)  # be gentle to data-api

    with _lock:
        _status["running"] = True
        _status["last_cycle_ts"] = time.time()
        _status["interval_s"] = interval


def watch_poller_loop(stop: threading.Event) -> None:
    with _lock:
        _status["running"] = True
    while not stop.is_set():
        try:
            _poll_cycle()
        except Exception as e:
            with _lock:
                _status["last_error"] = repr(e)
        with _lock:
            wait = float(_interval_s)
        stop.wait(wait)


def ensure_poller(stop: threading.Event) -> None:
    global _poller_started
    with _lock:
        if _poller_started:
            return
        _poller_started = True
    t = threading.Thread(target=watch_poller_loop, args=(stop,), daemon=True, name="wallet-watch")
    t.start()


def filter_since(payload: dict[str, Any], since: int | None) -> dict[str, Any]:
    if not since:
        return payload
    since_i = int(since)
    out = dict(payload)
    out["activity"] = [x for x in (payload.get("activity") or []) if int(x.get("timestamp") or 0) > since_i]
    out["trades"] = [x for x in (payload.get("trades") or []) if int(x.get("timestamp") or 0) > since_i]
    out["since"] = since_i
    out["incremental"] = True
    return out
