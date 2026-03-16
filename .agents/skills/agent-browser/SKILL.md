---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(agent-browser:*)
---

This skill is the Claude wrapper for the shared manual testing guidance in:

- `docs/common/ai/manual-testing-guide.md`

Read that guide first. It is the canonical, agent-neutral reference.

# Browser Automation with agent-browser

## Core Workflow

1. Navigate
2. Snapshot
3. Interact
4. Re-snapshot after navigation or DOM change

```bash
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser click @e1               # Click element
agent-browser fill @e2 "text"         # Clear and type text
agent-browser wait --load networkidle # Wait for network idle
agent-browser screenshot              # Screenshot to temp dir
```

The deeper command reference and templates remain under this skill's
`references/` and `templates/` directories.
