MUST HAVE:
- deno 2, pinned in mise.toml — install via mise https://mise.jdx.dev/
  (`mise trust && mise install` in the repo); a manually installed deno 2
  within the `tasks/check.sh` range also works

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
