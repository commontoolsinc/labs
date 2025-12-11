<!-- @reviewed 2025-12-10 docs-rationalization -->

# Local Development Server Setup

## The Problem

CommonTools requires **TWO separate servers** to run locally:

1. **Backend (Toolshed)** - Port 8000 - API and storage layer
2. **Frontend (Shell)** - Port 5173 - Web UI that renders spaces

**Critical**: You cannot access spaces through the browser without BOTH servers running. If only the backend is running, you'll get connection errors when trying to access `http://localhost:5173/[space-name]`.

## Quick Start - Starting Both Servers

### Terminal 1: Start Backend (Toolshed)
```bash
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev
```

**Expected output:**
- `Server running on http://0.0.0.0:8000`
- `Runtime initialized successfully`

### Terminal 2: Start Frontend (Shell)
```bash
cd packages/shell
deno task dev-local
```

**Expected output:**
- `🌐 Server: http://127.0.0.1:5173`
- `✓ Built /Users/.../dist/scripts/index.js`

## Verifying Servers Are Running

### Method 1: Health Check Commands
```bash
# Check backend (should return 200)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/_health

# Check frontend (should return 200)
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173
```

### Method 2: Using Playwright (Automated Testing)
```javascript
// Navigate to a space - this will fail if either server is down
mcp__playwright__playwright_navigate({ url: "http://localhost:5173/[space-name]" })

// Take screenshot to verify it loaded
mcp__playwright__playwright_screenshot({ name: "verify-space-loaded" })
```

### Method 3: Check Running Processes
```bash
# Check if servers are running on expected ports
lsof -i :8000  # Should show toolshed process
lsof -i :5173  # Should show shell/felt process
```

## Common Mistakes & Troubleshooting

### ❌ Only Backend Running
**Symptom**: `curl http://localhost:8000/_health` works, but `http://localhost:5173/[space]` fails
**Fix**: Start the Shell frontend server (see Terminal 2 above)

### ❌ Only Frontend Running
**Symptom**: Shell loads but spaces show errors or don't render
**Fix**: Start the Toolshed backend server (see Terminal 1 above)

### ❌ Wrong URL Used
**Symptom**: Accessing `http://localhost:8000/[space-name]` directly
**Fix**: Always access spaces through the Shell at `http://localhost:5173/[space-name]`

The backend (8000) serves the API; the frontend (5173) serves the UI.

## URL Structure

| What | URL | Server |
|------|-----|--------|
| Backend API | `http://localhost:8000` | Toolshed |
| Backend Health | `http://localhost:8000/_health` | Toolshed |
| Frontend/Shell | `http://localhost:5173` | Shell |
| **Access a Space** | `http://localhost:5173/[space-name]` | Shell → Toolshed |

## Background Server Management

When starting servers in background (for automated testing):

```bash
# Start backend in background
cd packages/toolshed && SHELL_URL=http://localhost:5173 deno task dev &
TOOLSHED_PID=$!

# Start frontend in background
cd packages/shell && deno task dev-local &
SHELL_PID=$!

# Wait for both to start
sleep 5

# Verify both are up
curl http://localhost:8000/_health && curl http://localhost:5173

# Kill when done
kill $TOOLSHED_PID $SHELL_PID
```

## Reliable Process Shutdown

When PIDs weren't tracked or processes become orphaned, use port-based termination:

### Force-Kill by Port

```bash
# Kill any process on port 8000 (Toolshed)
lsof -ti :8000 | xargs kill -9 2>/dev/null

# Kill any process on port 5173 (Shell)
lsof -ti :5173 | xargs kill -9 2>/dev/null
```

### Verify Ports Are Free

Always verify before restarting:

```bash
# Should return nothing if ports are free
lsof -i :8000
lsof -i :5173
```

### Complete Restart Workflow

```bash
# 1. Stop all processes on both ports
lsof -ti :8000 | xargs kill -9 2>/dev/null
lsof -ti :5173 | xargs kill -9 2>/dev/null

# 2. Wait briefly for cleanup
sleep 2

# 3. Verify ports are free
if lsof -i :8000 || lsof -i :5173; then
  echo "ERROR: Ports still in use"
  exit 1
fi

# 4. Start servers (in separate terminals or background)
cd packages/toolshed && SHELL_URL=http://localhost:5173 deno task dev &
TOOLSHED_PID=$!

cd packages/shell && deno task dev-local &
SHELL_PID=$!

# 5. Wait for startup
sleep 5

# 6. Verify both are healthy
curl -sf http://localhost:8000/_health > /dev/null && echo "Backend: OK" || echo "Backend: FAILED"
curl -sf http://localhost:5173 > /dev/null && echo "Frontend: OK" || echo "Frontend: FAILED"
```

### Troubleshooting Stubborn Processes

If `lsof -ti :PORT | xargs kill -9` doesn't work:

1. **Check for multiple processes:**
   ```bash
   lsof -i :8000  # Lists all processes with details
   ```

2. **Kill by process name (nuclear option):**
   ```bash
   pkill -9 -f "deno task dev"
   ```

3. **Check for child processes:**
   ```bash
   pgrep -f deno | xargs ps -p
   ```

4. **Last resort - kill all deno processes:**
   ```bash
   pkill -9 -f deno
   ```
   ⚠️ This kills ALL deno processes, not just dev servers.

## Integration with Pattern Development

When deploying patterns locally:

```bash
# 1. Ensure BOTH servers are running (see Quick Start above)

# 2. Deploy pattern to backend
deno task ct charm new path/to/pattern.tsx \
  --identity ~/labs/tony.key \
  --api-url http://localhost:8000 \
  --space my-space

# 3. Access in browser via frontend
# Open: http://localhost:5173/my-space
```

## Key Takeaway for AI Agents

**Before assuming local development is working:**
1. Check BOTH servers are running (ports 8000 AND 5173)
2. Verify with health checks or `lsof`
3. Always access spaces through `http://localhost:5173/[space-name]`
4. If using Playwright for testing, navigate to port 5173, not 8000

**Starting servers in background for testing:**
- Use `run_in_background: true` parameter in Bash tool
- Wait 3-5 seconds after starting before testing
- Use BashOutput tool to check server status
- Verify with health endpoints before proceeding
