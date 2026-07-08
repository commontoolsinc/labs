MUST HAVE:
- deno 2 https://docs.deno.com/runtime/getting_started/installation/

REALLY SHOULD HAVE:
- gh https://github.com/cli/cli
- claude code
  - `npm i -g @anthropic-ai/claude-code`
  - browser automation for pattern testing uses the bundled `agent-browser`
    skill — no MCP setup required
  - optional: Playwright MCP is a fallback browser driver for `/tour`:
    - `claude mcp add playwright npx '@playwright/mcp@latest'`
