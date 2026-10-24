"""Paper-only wallet watch helpers — load spider top-100 + public activity.

No keys, no CLOB writes. Uses Polymarket data-api / gamma public GETs only.
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from spider.http_util import http_get

ROOT = Path(__file__).resolve().parent.parent


def _resolve_spider_root() -> Path:
    """Deploy-friendly spider location: env, vendored copy, or sibling checkout."""
    import os

    env = (os.environ.get("GROK_SPIDER_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    vendor = ROOT / "vendor" / "polymarket-spider"
    if (vendor / "spider.py").is_file() or (vendor / "output" / "latest.csv").is_file():
        return vendor
    return ROOT.parent / "polymarket-spider"


SPIDER_ROOT = _resolve_spider_root()
SPIDER_CSV = SPIDER_ROOT / "output" / "latest.csv"
CACHE_DIR = ROOT / "state" / "wallet_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

STALE_HOURS = 12.0
ACTIVITY_TTL_S = 90.0
LIST_TTL_S = 30.0

_lock = threading.Lock()
_list_cache: dict[str, Any] = {"ts": 0.0, "payload": None}
_refreshing = False


def _csv_age_hours() -> float | None:
    if not SPIDER_CSV.exists():
        return None
    return (time.time() - SPIDER_CSV.stat().st_mtime) / 3600.0


def maybe_refresh_spider(*, force: bool = False) -> dict[str, Any]:
    """Run polymarket-spider if missing or older than STALE_HOURS. Non-blocking after start."""
    global _refreshing
    age = _csv_age_hours()
    need = force or age is None or age > STALE_HOURS
    info: dict[str, Any] = {
        "csv": str(SPIDER_CSV),
        "age_hours": None if age is None else round(age, 2),
        "refreshed": False,
        "refreshing": False,
        "stale_threshold_h": STALE_HOURS,
    }
    if not need:
        return info
    with _lock:
        if _refreshing:
            info["refreshing"] = True
            return info
        _refreshing = True

    def _run() -> None:
        global _refreshing
        try:
            script = SPIDER_ROOT / "spider.py"
            if script.exists():
                subprocess.run(
                    [sys.executable, str(script), "--limit", "100", "--time-period", "all"],
                    cwd=str(SPIDER_ROOT),
                    timeout=180,
                    check=False,
                    capture_output=True,
                )
                with _lock:
                    _list_cache["ts"] = 0.0
        except Exception:
            pass
        finally:
            with _lock:
                _refreshing = False

    threading.Thread(target=_run, daemon=True).start()
    info["refreshing"] = True
    info["refreshed"] = True  # kickoff
    return info


def _f(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v: Any, default: int = 0) -> int:
    try:
        if v is None or v == "":
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


def load_wallets_from_csv() -> list[dict[str, Any]]:
    if not SPIDER_CSV.exists():
        return []
    rows: list[dict[str, Any]] = []
    with SPIDER_CSV.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            addr = (r.get("address") or "").strip().lower()
            if not addr.startswith("0x"):
                continue
            rows.append(
                {
                    "rank": _i(r.get("rank")),
                    "address": addr,
                    "username": (r.get("username") or "").strip() or None,
                    "pnl_usdc": _f(r.get("pnl_usdc")),
                    "volume_usdc": _f(r.get("volume_usdc")),
                    "volume_shares": _f(r.get("volume_shares")),
                    "trade_count": _i(r.get("trade_count")),
                    "markets_traded": _i(r.get("markets_traded")),
                    "biggest_win_usdc": _f(r.get("biggest_win_usdc")),
                    "trade_frequency_proxy": (r.get("trade_frequency_proxy") or "").strip() or None,
                    "join_date": (r.get("join_date") or "").strip() or None,
                    "suspected_strategy": (r.get("suspected_strategy") or "unknown").strip()
                    or "unknown",
                    "strategy_reason": (r.get("strategy_reason") or "").strip() or None,
                    "x_username": (r.get("x_username") or "").strip() or None,
                    "verified": str(r.get("verified") or "").lower() in ("true", "1", "yes"),
                }
            )
    rows.sort(key=lambda x: x["rank"] or 9999)
    return rows


def list_wallets(
    *,
    strategy: str | None = None,
    min_pnl: float | None = None,
    q: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    refresh_info = maybe_refresh_spider()
    now = time.time()
    with _lock:
        if _list_cache["payload"] and (now - float(_list_cache["ts"])) < LIST_TTL_S:
            wallets = list(_list_cache["payload"])
        else:
            wallets = load_wallets_from_csv()
            _list_cache["payload"] = wallets
            _list_cache["ts"] = now

    strat = (strategy or "").strip().lower()
    query = (q or "").strip().lower()
    out = []
    for w in wallets:
        if strat and strat not in ("all", "*") and (w.get("suspected_strategy") or "").lower() != strat:
            continue
        if min_pnl is not None and float(w.get("pnl_usdc") or 0) < min_pnl:
            continue
        if query:
            hay = f"{w.get('username') or ''} {w.get('address') or ''} {w.get('x_username') or ''}".lower()
            if query not in hay:
                continue
        out.append(w)
        if len(out) >= limit:
            break

    strategies = sorted({(w.get("suspected_strategy") or "unknown") for w in wallets})
    age = _csv_age_hours()
    return {
        "paper_only": True,
        "disclaimer": "PAPER / OBSERVE ONLY — no live orders, no keys",
        "source_csv": str(SPIDER_CSV),
        "csv_mtime": SPIDER_CSV.stat().st_mtime if SPIDER_CSV.exists() else None,
        "csv_age_hours": None if age is None else round(age, 2),
        "count": len(out),
        "total_in_csv": len(wallets),
        "strategies": strategies,
        "wallets": out,
        "refresh": refresh_info,
        "ts": now,
        "tz": "Asia/Hong_Kong (UTC+8)",
    }


def _cache_path(addr: str) -> Path:
    safe = addr.lower().replace("/", "")[:66]
    return CACHE_DIR / f"{safe}.json"


def _read_activity_cache(addr: str) -> dict[str, Any] | None:
    p = _cache_path(addr)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if time.time() - float(data.get("_cached_at") or 0) > ACTIVITY_TTL_S:
            return None
        return data
    except Exception:
        return None


def _write_activity_cache(addr: str, payload: dict[str, Any]) -> None:
    payload = dict(payload)
    payload["_cached_at"] = time.time()
    try:
        _cache_path(addr).write_text(json.dumps(payload, default=str), encoding="utf-8")
    except Exception:
        pass


def _norm_activity_item(it: dict[str, Any]) -> dict[str, Any]:
    # tolerate camelCase (legacy) and snake_case (v2)
    def g(*keys: str, default: Any = None) -> Any:
        for k in keys:
            if k in it and it[k] is not None:
                return it[k]
        return default

    return {
        "type": g("type", default=""),
        "side": g("side", default=""),
        "title": g("title", default=""),
        "slug": g("slug", default=""),
        "event_slug": g("eventSlug", "event_slug", default=""),
        "outcome": g("outcome", default=""),
        "price": _f(g("price")),
        "size": _f(g("size")),
        "usdc_size": _f(g("usdcSize", "usdc_size")),
        "timestamp": _i(g("timestamp")),
        "tx": g("transactionHash", "transaction_hash", default=""),
        "icon": g("icon", default=""),
    }


def fetch_wallet_recent(addr: str, *, limit: int = 40, nocache: bool = False, since: int | None = None) -> dict[str, Any]:
    addr = addr.strip().lower()
    if not addr.startswith("0x") or len(addr) < 10:
        return {"error": "invalid_address", "address": addr, "paper_only": True}

    if not nocache:
        cached = _read_activity_cache(addr)
        if cached and not cached.get("error"):
            cached = dict(cached)
            cached["cache_hit"] = True
            if since:
                since_i = int(since)
                cached["activity"] = [x for x in (cached.get("activity") or []) if int(x.get("timestamp") or 0) > since_i]
                cached["trades"] = [x for x in (cached.get("trades") or []) if int(x.get("timestamp") or 0) > since_i]
                cached["since"] = since_i
                cached["incremental"] = True
            return cached

    activity: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    profile: dict[str, Any] | None = None
    err: str | None = None

    try:
        raw = http_get(f"{DATA_API}/activity", {"user": addr, "limit": min(limit, 50)})
        if isinstance(raw, list):
            activity = [_norm_activity_item(x) for x in raw if isinstance(x, dict)]
        elif isinstance(raw, dict):
            batch = raw.get("data") or raw.get("activities") or []
            activity = [_norm_activity_item(x) for x in batch if isinstance(x, dict)]
    except Exception as e:
        err = f"activity: {e!r}"

    try:
        raw_t = http_get(f"{DATA_API}/trades", {"user": addr, "limit": min(limit, 50)})
        if isinstance(raw_t, list):
            trades = [_norm_activity_item({**x, "type": x.get("type") or "TRADE"}) for x in raw_t if isinstance(x, dict)]
        elif isinstance(raw_t, dict):
            batch = raw_t.get("data") or []
            trades = [_norm_activity_item({**x, "type": x.get("type") or "TRADE"}) for x in batch if isinstance(x, dict)]
    except Exception as e:
        if not err:
            err = f"trades: {e!r}"

    try:
        profile = http_get(f"{GAMMA_API}/public-profile", {"address": addr})
        if not isinstance(profile, dict):
            profile = None
    except Exception:
        profile = None

    # Markets summary from recent activity titles
    markets: dict[str, int] = {}
    for it in activity + trades:
        title = (it.get("title") or "").strip()
        if title:
            markets[title] = markets.get(title, 0) + 1
    top_markets = sorted(
        [{"title": k, "hits": v} for k, v in markets.items()],
        key=lambda x: -x["hits"],
    )[:12]

    # Merge wallet meta from CSV if present
    meta = None
    for w in load_wallets_from_csv():
        if w["address"] == addr:
            meta = w
            break

    payload = {
        "paper_only": True,
        "disclaimer": "PAPER / OBSERVE ONLY — public reads; local notes only",
        "address": addr,
        "wallet": meta,
        "profile": {
            "name": (profile or {}).get("name"),
            "pseudonym": (profile or {}).get("pseudonym"),
            "proxy_wallet": (profile or {}).get("proxyWallet"),
            "verified_badge": (profile or {}).get("verifiedBadge"),
            "created_at": (profile or {}).get("createdAt"),
        }
        if profile
        else None,
        "activity": activity[:limit],
        "trades": trades[:limit],
        "markets": top_markets,
        "error": err,
        "cache_hit": False,
        "ts": time.time(),
        "tz": "Asia/Hong_Kong (UTC+8)",
        "polymarket_url": f"https://polymarket.com/profile/{addr}",
    }
    if not err:
        _write_activity_cache(addr, payload)
    if since:
        since_i = int(since)
        payload = dict(payload)
        payload["activity"] = [x for x in (payload.get("activity") or []) if int(x.get("timestamp") or 0) > since_i]
        payload["trades"] = [x for x in (payload.get("trades") or []) if int(x.get("timestamp") or 0) > since_i]
        payload["since"] = since_i
        payload["incremental"] = True
    return payload
