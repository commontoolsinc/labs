<!-- @reviewed 2025-12-11 docs-rationalization -->

# Local Development Servers - Troubleshooting

## Quick Reference

**Use the scripts** (see ct skill for full documentation):

```bash
./scripts/start-local-dev.sh          # Start both servers
./scripts/stop-local-dev.sh           # Stop both servers
./scripts/restart-local-dev.sh        # Restart both
./scripts/restart-local-dev.sh --force       # Force kill first
./scripts/restart-local-dev.sh --clear-cache # Clear disposable caches (preserves spaces)
./scripts/restart-local-dev.sh --dangerously-clear-all-spaces # Clear databases/spaces
```

**URLs:**
| What | URL |
|------|-----|
| Backend API | `http://localhost:8000` |
| Frontend/Shell | `http://localhost:8000` |
| Access a space | `http://localhost:8000/[space-name]` |

**Logs:**
- `packages/shell/local-dev-shell.log`
- `packages/toolshed/local-dev-toolshed.log`

**First-time browser login:**

When accessing a space for the first time, you'll need to register:
1. Click "➕ Register"
2. Click "🔑 Generate Passphrase"
3. Click "🔒 I've Saved It - Continue"

For Playwright testing, use:
```javascript
await page.goto("http://localhost:8000/<SPACE>/<CHARM_ID>");
```

---

## Architecture

CommonTools requires **two servers** for local development:

1. **Backend (Toolshed)** - Port 8000 - API, storage, runtime, proxies shell
2. **Frontend (Shell)** - Port 5173 - Dev server with hot reload (accessed via 8000 proxy)

You cannot access spaces without BOTH running. Access the application at **port 8000**, which proxies to shell. The scripts handle starting them in the correct order.

**Important:** Use `dev-local` (not `dev`) for shell when running against local Toolshed. The `dev` task points to production.

**After editing runtime code:** Restart the servers to pick up changes.

---

## Troubleshooting

### Scripts Not Working

**Check if ports are in use:**
```bash
# macOS or Linux with lsof
lsof -i :8000  # Toolshed
lsof -i :5173  # Shell

# Linux without lsof (use ss instead)
ss -tlnp 'sport = :8000'  # Toolshed
ss -tlnp 'sport = :5173'  # Shell
```

**Force restart:**
```bash
./scripts/restart-local-dev.sh --force
```

### Verifying Servers Are Running

```bash
# Health checks (should return 200)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/_health  # Toolshed
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173          # Shell
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Commands hang/timeout | Servers not running | Run `./scripts/restart-local-dev.sh` |
| Space shows errors | Only one server running | Ensure BOTH are running |
| Port already in use | Previous server didn't stop | Use `--force` flag |
| Stale data | Cache issues | Use `--clear-cache` flag (or `--dangerously-clear-all-spaces` for database issues) |
| `*.ts.net` URLs hang | Not on Tailscale | Connect to CT network via Tailscale |
| OAuth error: `Unexpected token '<'` | Fetching from wrong port | Use port 8000 for API calls ([see below](#oauth-returns-html-instead-of-json)) |
| UI component changes not appearing | Shell doesn't watch packages/ui | Restart local dev server |

### Manual Fallback

If scripts fail completely, manual process:

```bash
# 1. Kill by port (choose based on your system)
# macOS or Linux with lsof:
lsof -ti :8000 | xargs kill -9 2>/dev/null  # Toolshed
lsof -ti :5173 | xargs kill -9 2>/dev/null  # Shell

# Linux without lsof (use ss + awk):
ss -tlnp 'sport = :8000' | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | xargs kill -9 2>/dev/null
ss -tlnp 'sport = :5173' | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | xargs kill -9 2>/dev/null

# 2. Wait for cleanup
sleep 2

# 3. Start backend (Terminal 1)
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev

# 4. Start frontend (Terminal 2)
cd packages/shell
deno task dev-local
```

**Alternative: Local shell with cloud backend:**
```bash
cd packages/toolshed
SHELL_URL=http://localhost:5173 API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```

**Environment setup:** Copy `.env.example` to `.env` in the toolshed directory. See `packages/toolshed/env.ts` for all available environment variables.

### Checking Logs

```bash
# View recent shell errors
tail -50 packages/shell/local-dev-shell.log

# View recent toolshed errors
tail -50 packages/toolshed/local-dev-toolshed.log

# Follow logs in real-time
tail -f packages/shell/local-dev-shell.log
tail -f packages/toolshed/local-dev-toolshed.log
```

### OAuth Returns HTML Instead of JSON

**Error:** `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

This happens when OAuth or API calls hit port 5173 (frontend) instead of port 8000 (backend). The frontend returns HTML, which fails JSON parsing.

| Port | Server | Returns |
|------|--------|---------|
| **5173** | Frontend (Shell) | HTML |
| **8000** | Backend (Toolshed) | JSON |

**Fix:** Ensure API calls use port 8000:
- Deployment: `--api-url http://localhost:8000`
- In patterns: Check `getRecipeEnvironment().apiUrl`
- Browser testing: Navigate to `http://localhost:5173` for UI, but API calls should target 8000

### UI Component Changes Not Appearing

When editing `ct-*` components in `packages/ui/`, restart the local dev server to ensure the updated code is running.

---

## Background Charm Service (Optional)

The background-charm-service polls registered charms and triggers their `bgUpdater` handlers server-side. This is **optional** - only needed if you're testing background/scheduled charm execution.

### Quick Setup

```bash
# 1. Build binaries (if not already done)
deno task build-binaries

# 2. Ensure toolshed is running (uses "implicit trust" identity in dev mode)
./scripts/restart-local-dev.sh

# 3. Set up admin charm (grants bg-service access to system space)
cd packages/background-charm-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-charm

# 4. Start the background service
cd /path/to/labs
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" ./dist/bg-charm-service
```

### Registering a Charm for Background Updates

Charms must be registered to receive background polling:

```bash
# Via curl
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{"charmId":"baedrei...","space":"did:key:z6Mk...","integration":"my-integration"}'
```

Or use the `<ct-updater>` component in your charm's UI.

### Key Details

- **Polling interval**: 60 seconds (default)
- **Identity**: Must match toolshed's identity (in dev mode: `OPERATOR_PASS="implicit trust"`)
- **bgUpdater triggers**: Service sends `{}` to the charm's `bgUpdater` Stream
- **Logs**: Watch service output for `Successfully executed charm` messages

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CompilerError: no exported member 'pattern'` | Binary version mismatch | Run `deno task build-binaries` |
| `AuthorizationError` on system space | Admin charm not set up | Run `add-admin-charm` step |
| Charm not polling | Not registered | Register via `/api/integrations/bg` |

See `packages/background-charm-service/CLAUDE.md` for more details.
