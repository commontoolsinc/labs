# Dependencies and Integrations

**Note**: If you just want to get set up quickly, use the `/setup` command. This file documents all the dependencies for reference.

## Required

**Deno 2**: Runtime for backend, tooling, and pattern development
- Install: https://docs.deno.com/runtime/getting_started/installation/
- Verify: `deno --version`

## Recommended for Development

**GitHub CLI**: For PR and issue workflows
- Install: https://github.com/cli/cli
- Used by various slash commands for GitHub integration

**Claude Code**: For AI-assisted development
- Install: `npm i -g @anthropic/claude-code`
- Provides slash commands and AI assistance for pattern development

## Optional MCP Integrations

These enhance Claude Code with additional capabilities:

**Linear MCP Server**: Task and project management
```bash
claude mcp add --transport sse linear-server https://mcp.linear.app/sse
```
- Enables `/linear` command for workflow management

**Playwright MCP**: Browser automation for testing patterns
```bash
claude mcp add playwright npx '@playwright/mcp@latest'
```
- Required for `/explore-recipe` and interactive pattern testing
- Automatically tests deployed patterns in browser

## What Gets Installed by Setup

When you run `/setup` or follow the setup guide, you'll:
1. Build the `ct` binary (pattern deployment tool)
2. Create a local identity key (`claude.key`)
3. Optionally start local backend/frontend servers

No additional dependencies are required to deploy your first pattern!
