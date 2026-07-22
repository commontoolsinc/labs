<!-- @reviewed 2025-12-11 docs-rationalization -->

# Local Development Servers - Troubleshooting

## Quick Reference

**Use the scripts** (see the cf skill for full documentation):

```bash
./scripts/start-local-dev.sh          # Start both servers
./scripts/stop-local-dev.sh           # Stop both servers
./scripts/restart-local-dev.sh        # Restart both
./scripts/restart-local-dev.sh --force       # Force kill first
./scripts/restart-local-dev.sh --clear-cache # Clear disposable caches (preserves spaces)
./scripts/restart-local-dev.sh --dangerously-clear-all-spaces # Clear databases/spaces
./scripts/restart-local-dev.sh --bg-updater  # Also start background-piece-service
./scripts/check-local-dev.sh          # Health check both servers
./scripts/share-pattern-via-tailscale.sh packages/patterns/lunch-poll/main.tsx  # Host a pattern + share on your tailnet
./scripts/share-pattern-via-tailscale.sh --down                                 # Tear that down
```

To make source-run build metadata describe the checkout the same way compiled
binaries do, pass the current revision into the start script:

```bash
COMMIT_SHA="$(git rev-parse HEAD)" ./scripts/start-local-dev.sh --bg-updater
```

The script's children inherit the value: toolshed uses it as the source-run
fallback for `/api/meta.gitSha`, and shell surfaces it in diagnostics. The
source-run shell still loads its mutable worker graph from `/scripts`; only a
deployed shell selects the immutable `/builds/<sha>` namespace. `COMMIT_SHA` is
descriptive metadata, not a system-pattern update gate. The updater instead
compiles the downloaded source/import closure and requires its entry identity
to equal `?identity` before changing the persisted root.

To let teammates interact with a locally-hosted pattern (e.g. "host latest-main
`<pattern>` locally with `--inspect` and export it over Tailscale"), use
`share-pattern-via-tailscale.sh`. It starts an isolated toolshed (with
`--inspect`) + shell on offset ports, deploys the pattern, and `tailscale serve`s
it (tailnet-only). It launches the shell with `API_URL` set to your MagicDNS name
— the standard `dev-local` task bakes in `localhost`, which breaks remote
browsers.

`start-local-dev.sh` validates required commands before launching anything and
waits for both servers to bind their ports and return HTTP 200 before reporting
success. Set `LOCAL_DEV_STARTUP_TIMEOUT` to adjust the readiness timeout in
seconds.

**Exit codes (`start-local-dev.sh`):**
| Code | Meaning |
|------|---------|
| `0` | Both servers started and became ready. |
| `3` | A server could not bind because its port is already in use; retry on a different port offset. |
| other non-zero | Any other startup failure (build error, crash, readiness timeout). |

Code `3` is reported only when a server's actual bind fails, not from a port
pre-check, so it carries no check-then-bind race. The toolshed and the shell dev
server exit with the same code, and `deno task integration` relies on it to
retry a generated offset on a collision while aborting on any other failure.

**URLs:**
| What | URL |
|------|-----|
| Backend API | `http://localhost:8000` |
| Frontend/Shell | `http://localhost:8000` |
| Access a space | `http://localhost:8000/[space-name]` |

**Experimental flags:** Pass env vars to the start/restart scripts to enable
experiments on both servers:
```bash
EXPERIMENTAL_EXAMPLE_NAME_1=true \
EXPERIMENTAL_EXAMPLE_NAME_2=true \
./scripts/restart-local-dev.sh --force --dangerously-clear-all-spaces
```
The same env vars must also be set when running `cf` CLI commands against the
server. See `docs/development/EXPERIMENTAL_OPTIONS.md` for all available flags.

**Logs:**
- `packages/shell/local-dev-shell.log`
- `packages/toolshed/local-dev-toolshed.log`

**CLI identity for local dev:** The local toolshed uses an identity derived from
the passphrase `"implicit trust"`. To create a key matching the local server (so
the CLI can act as its operator/admin):
```bash
deno run -A packages/cli/mod.ts id derive "implicit trust" > claude.key
export CF_IDENTITY=./claude.key
```
This is a shared, publicly-derivable key — every developer who derives it gets
the same DID. Use it only against your own localhost. For a personal identity, or
any shared/remote server, use `id new` instead (see
[`SHARED_IDENTITY.md`](./SHARED_IDENTITY.md)).

For workflows that touch `PerUser`, `PerSession`, favorites, or home-space
state, use one shared identity in both browser and CLI. The browser login screen
can import a CLI PKCS8/PEM key via `Import CLI Key`. See
[`SHARED_IDENTITY.md`](./SHARED_IDENTITY.md).

**First-time browser login:**

When accessing a space for the first time, you'll need to register:
1. Click "➕ Register"
2. Click "🔑 Generate Passphrase"
3. Click "🔒 I've Saved It - Continue"

For Playwright testing, use:
```javascript
// Shown inside a pattern body.
await page.goto("http://localhost:8000/<SPACE>/<PIECE_ID>");
```

---

## Architecture

Common Fabric requires **two servers** for local development:

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
./scripts/check-local-dev.sh
```

This checks both process presence and HTTP health, exiting non-zero if
anything is wrong. It supports the same `--port-offset`, `--shell-port`, and
`--toolshed-port` flags as the other scripts.

When `--port-offset` changes the toolshed port, `start-local-dev.sh` also sets
toolshed's internal `API_URL` and `MEMORY_URL` to the offset toolshed URL unless
those variables are already exported in the shell environment.

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Commands hang/timeout | Servers not running | Run `./scripts/restart-local-dev.sh` |
| Space shows errors | Only one server running | Ensure BOTH are running |
| Port already in use | Previous server didn't stop | Use `--force` flag |
| Stale data | Cache issues | Use `--clear-cache` flag (or `--dangerously-clear-all-spaces` for database issues) |
| `*.ts.net` URLs hang | Not on Tailscale | Connect to the Tailscale network |
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
TOOLSHED_PORT=8000 deno task dev-local
```

**Alternative: Local shell with cloud backend:**
```bash
cd packages/toolshed
SHELL_URL=http://localhost:5173 API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```

**Environment setup:** Copy `.env.example` to `.env` in the toolshed directory. See [`CONFIGURATION.md`](./CONFIGURATION.md) for a categorized reference of all configuration (env vars, tasks, flags), or `packages/toolshed/env.ts` for the canonical Zod schema.

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
- In patterns: Check `getPatternEnvironment().apiUrl`
- Browser testing: Navigate to `http://localhost:5173` for UI, but API calls should target 8000

### UI Component Changes Not Appearing

When editing `cf-*` components in `packages/ui/`, restart the local dev server to ensure the updated code is running.

---

## Background Piece Service (Optional)

The background-piece-service polls registered pieces and triggers their `bgUpdater` handlers server-side. This is **optional** - only needed if you're testing background/scheduled piece execution (e.g., auto-refreshing Google OAuth tokens).

### Quick Setup (Recommended)

Use the `--bg-updater` flag with the local dev scripts:

```bash
./scripts/start-local-dev.sh --bg-updater
# or
./scripts/restart-local-dev.sh --bg-updater
```

This waits for toolshed to be healthy, then starts the background service. The service log is at `packages/background-piece-service/local-dev-bg.log`. The stop script will also clean up the background service process. The system space cell is auto-created when a piece is first registered (e.g., during Google OAuth).

### Manual Setup

If you prefer manual control:

```bash
# 1. Ensure toolshed is running (uses "implicit trust" identity in dev mode)
./scripts/restart-local-dev.sh

# 2. Start the background service from source
cd packages/background-piece-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task start
```

> **Optional:** The `add-admin-piece` task deploys an admin dashboard piece
> into the system space. It is **not** required for normal background-service
> operation -- the system space cell is bootstrapped automatically by
> `setBGPiece()` during the OAuth callback when a piece is first registered.
> Run it only if you want the admin dashboard:
>
> ```bash
> cd packages/background-piece-service
> OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-piece
> ```

### Registering a Piece for Background Updates

Pieces must be registered to receive background polling:

```bash
# Via curl
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{"pieceId":"fid1:abc...","space":"did:key:z6Mk...","integration":"my-integration"}'
```

Or use the `<cf-updater>` component in your piece's UI.

### Key Details

- **Polling interval**: 60 seconds (default)
- **Identity**: Must match toolshed's identity (in dev mode: `OPERATOR_PASS="implicit trust"`)
- **bgUpdater triggers**: Service sends `{}` to the piece's `bgUpdater` Stream
- **Logs**: Watch service output for `Successfully executed piece` messages

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CompilerError: no exported member 'pattern'` | Binary version mismatch | Run `deno task build-binaries` |
| `AuthorizationError` on system space | System space not yet bootstrapped | Register a piece (e.g., via OAuth) to auto-create it, or run optional `add-admin-piece` |
| Piece not polling | Not registered | Register via `/api/integrations/bg` |

See `packages/background-piece-service/CLAUDE.md` for more details.
