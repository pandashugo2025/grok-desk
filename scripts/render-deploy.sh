#!/usr/bin/env bash
# Manual Render deploy for grok-desk when GitHub auto-deploy webhook is missing.
# Requires: RENDER_API_KEY from https://dashboard.render.com/u/settings#api-keys
set -euo pipefail
SERVICE_ID="${RENDER_SERVICE_ID:-srv-dbe737fb9u1s738l4spg}"
CLEAR_CACHE="${CLEAR_CACHE:-false}"
if [[ -z "${RENDER_API_KEY:-}" ]]; then
  echo "Set RENDER_API_KEY (Render Dashboard → Account Settings → API Keys)." >&2
  echo "Also see docs/RENDER-AUTODEPLOY.md to fix GitHub App auto-deploy." >&2
  exit 1
fi
body='{"clearCache":"do_not_clear"}'
if [[ "$CLEAR_CACHE" == "true" || "$CLEAR_CACHE" == "1" ]]; then
  body='{"clearCache":"clear"}'
fi
echo "Triggering deploy for $SERVICE_ID ..."
curl -sS -X POST "https://api.render.com/v1/services/${SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d "$body"
echo
