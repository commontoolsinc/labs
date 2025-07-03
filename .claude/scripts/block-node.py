#!/usr/bin/env python3
import json, re, sys

data = json.load(sys.stdin)
cmd  = data.get("tool_input", {}).get("command", "")

# If Claude is about to run a shell command that uses a Node package-manager…
if re.search(r'\b(npm|npx|yarn|pnpm|node)\b', cmd):
    # Send feedback to Claude and *block* the tool call
    print("We use **Deno** in this repo – please rewrite the command accordingly.", file=sys.stderr)
    sys.exit(2)        # exit-code 2 = “block & show stderr to Claude”
# Otherwise let the call proceed
sys.exit(0)
