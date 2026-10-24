"""Tiny HTTP GET helper with retries (stdlib only)."""
from __future__ import annotations

import json
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = "grok-desk/0.1 (paper-sim; read-only; local research)"


def http_get(
    url: str,
    params: dict[str, Any] | None = None,
    *,
    retries: int = 3,
    timeout: float = 20.0,
) -> Any:
    if params:
        qs = urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{url}?{qs}" if "?" not in url else f"{url}&{qs}"
    last: Exception | None = None
    for attempt in range(retries):
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                if not raw:
                    return None
                return json.loads(raw)
        except HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(0.8 * (attempt + 1))
                continue
            raise
        except (URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(0.8 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"GET failed: {url} ({last})")
