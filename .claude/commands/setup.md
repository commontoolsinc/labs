# Setup Command - Automated Setup

This command automatically sets up your local Common Tools environment, starts the servers, and deploys your first pattern.

## What This Command Does

1. Checks that Deno is installed
2. Builds the ct binary if needed
3. Creates an identity key if needed
4. Starts local backend and frontend servers
5. Deploys a demo pattern
6. Gives you the URL to visit and next steps

## Instructions for Claude

When the user invokes this command:

### Step 1: Check Prerequisites

Check if deno is installed:
```bash
deno --version
```

If not installed, tell the user:
"You need to install Deno first. Visit https://docs.deno.com/runtime/getting_started/installation/ and then run this command again."

### Step 2: Build ct Binary (if needed)

Check if ct binary exists:
```bash
ls -la ./dist/ct
```

If it doesn't exist, build it:
```bash
deno task build-binaries --cli-only
```

Tell the user: "Building the ct command-line tool... (this takes about 30 seconds)"

### Step 3: Create Identity Key (if needed)

Check if identity key exists:
```bash
ls -la claude.key
```

If it doesn't exist, create it:
```bash
./dist/ct id new > claude.key
```

Tell the user: "Created your local identity key (claude.key)"

### Step 4: Start Local Servers

Start the backend in background:
```bash
cd packages/toolshed && deno task dev
```

Wait 5 seconds, then start the frontend in background:
```bash
cd packages/shell && deno task dev-local
```

Wait 5 seconds for frontend to be ready.

Tell the user: "Started local backend (port 8000) and frontend (port 5173)"

### Step 5: Deploy Demo Pattern

Deploy the checkbox demo pattern:
```bash
./dist/ct charm new --identity claude.key --api-url http://localhost:8000 --space test-space packages/patterns/ct-checkbox-cell.tsx
```

Capture the charm ID from the output.

Tell the user: "Deployed demo pattern! Charm ID: [CHARM_ID]"

### Step 6: Give User Next Steps

Tell the user:

"✅ Setup complete! Here's what to do next:

**1. Visit your pattern:**
   Open: http://localhost:5173/test-space/[CHARM_ID]

**2. First time? Register:**
   - Click '➕ Register'
   - Click '🔑 Generate Passphrase'
   - Click '🔒 I've Saved It - Continue'
   - You'll see your checkbox demo running!

**3. Deploy another pattern:**
   Try deploying a different pattern from packages/patterns/:

   ```bash
   ./dist/ct charm new --identity claude.key --api-url http://localhost:8000 --space test-space packages/patterns/dice.tsx
   ```

   Then visit: http://localhost:5173/test-space/[NEW_CHARM_ID]

**4. Modify a pattern:**
   Edit packages/patterns/ct-checkbox-cell.tsx, then update:

   ```bash
   ./dist/ct charm setsrc --identity claude.key --api-url http://localhost:8000 --space test-space --charm [CHARM_ID] packages/patterns/ct-checkbox-cell.tsx
   ```

   Refresh your browser to see changes!

**5. Next steps:**
   - Use `pattern-dev` skill for AI-assisted pattern development
   - Browse packages/patterns/ for more examples
   - Read docs/common/RECIPES.md to understand how patterns work
   - Run `./dist/ct --help` to see all available commands

**Recommended patterns to try:**
- ct-select.tsx - Dropdown component
- dice.tsx - Random dice roller
- counter.tsx - Simple counter with handlers

The servers are running in the background. Have fun building!"

### Step 7: Remember the Charm ID

Store the charm ID so you can reference it if the user asks questions later.

## Important Notes for Claude

- Always use background mode when starting servers (`run_in_background: true`)
- Wait for servers to fully start before deploying patterns
- Capture and show the charm ID to the user
- Make the URL clickable/clear
- Explain the registration flow clearly (it's confusing the first time)
- Show concrete examples for next steps, not just generic advice
