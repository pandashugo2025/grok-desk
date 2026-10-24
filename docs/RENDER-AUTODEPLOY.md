# Render auto-deploy fix (GROK DESK)

## What’s wrong

Render service `grok-desk` (`srv-dbe737fb9u1s738l4spg`) already has:

- `autoDeploy: yes`
- `autoDeployTrigger: commit`
- branch `main`
- repo `https://github.com/pandashugo2025/grok-desk`

But **pushes never start a deploy**. Every successful ship so far was `trigger: api` (manual / MCP `trigger_deploy`).

On GitHub, `GET /repos/pandashugo2025/grok-desk/hooks` returns **`[]`** (no Render webhook / no App-delivered push hook visible). Render’s MCP tools can *read* the service and *trigger* deploys, but **cannot** reconnect the GitHub App or rewrite repo credentials.

Root cause: **Render GitHub App is not receiving push events for this repo** (missing/partial install, or service created from a public URL without App access to the repo).

## Fix in the Render + GitHub dashboards (required)

Do these once as the Render account owner (`pandashugo@gmail.com`):

1. **Install / configure Render’s GitHub App**  
   Open: https://github.com/apps/render/installations/new  
   - Choose the account that owns `pandashugo2025/grok-desk`.  
   - Under **Repository access**, include **`pandashugo2025/grok-desk`** (or “All repositories”).  
   - Save.

2. **Confirm Git credential on Render**  
   Open: https://dashboard.render.com/u/settings#github  
   (Account Settings → Git Deployment Credentials / Account Security)  
   - GitHub should show as connected.  
   - If unsure, disconnect + reconnect GitHub, then re-check step 1’s repo access.

3. **Reconnect the service repo**  
   Open: https://dashboard.render.com/web/srv-dbe737fb9u1s738l4spg/settings  
   - Find **Git** / repository section.  
   - Confirm Auto-Deploy = **On Commit** (or equivalent).  
   - If there is **Disconnect / Connect repository**, reconnect `pandashugo2025/grok-desk` on branch **`main`**.

4. **Verify**  
   - Push a tiny commit to `main`.  
   - Within ~30–60s a new deploy should appear with trigger **not** only API (dashboard usually shows the commit).  
   - Optional: GitHub → repo → **Settings → Webhooks / GitHub Apps** should list **Render**.

## Agent workaround until the App is fixed

```bash
# one-time: create a Render API key in the dashboard, then:
export RENDER_API_KEY=rnd_...
./scripts/render-deploy.sh
```

Or from chat: ask Grok Bot to call Render `trigger_deploy` for `srv-dbe737fb9u1s738l4spg`.

Do **not** add a 24/7 keep-alive cron (burns free hours / billing concern).

## Optional: health check path

Blueprint `render.yaml` sets `healthCheckPath: /health`, but the live service still shows an empty health check path (Blueprint was not re-applied). In Settings → Health Check Path, set `/health` manually if you want Render’s health probes.
