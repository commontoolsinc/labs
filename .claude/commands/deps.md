MUST HAVE:
- deno 2 https://docs.deno.com/runtime/getting_started/installation/

REALLY SHOULD HAVE:
- gh https://github.com/cli/cli
- claude code
  - `npm i -g @anthropic-ai/claude-code`
- agent-browser CLI — enables browser-based pattern testing (see
  `skills/agent-browser/SKILL.md` and `docs/common/ai/manual-testing-guide.md`)

OPTIONAL:
- Playwright MCP — fallback browser driver for `/tour` when agent-browser is
  unavailable:
  - `claude mcp add playwright npx '@playwright/mcp@latest'`
