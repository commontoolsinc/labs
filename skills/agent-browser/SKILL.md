---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(agent-browser:*)
---

Start with the shared manual testing guidance in:

- `docs/common/ai/manual-testing-guide.md`

Read that guide first. It is the canonical reference.

# Browser Automation with agent-browser

## Core Workflow

Every browser automation follows this pattern:

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i`
3. Interact: use refs to click, fill, select, or inspect
4. Re-snapshot after navigation or DOM change

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i
```

## Essential Commands

```bash
# Navigation
agent-browser open <url>
agent-browser close

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs
agent-browser snapshot -s "#selector"

# Interaction
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser select @e1 "option"
agent-browser check @e1
agent-browser press Enter
agent-browser scroll down 500

# Get information
agent-browser get text @e1
agent-browser get url
agent-browser get title

# Wait
agent-browser wait @e1
agent-browser wait --load networkidle
agent-browser wait --url "**/page"
agent-browser wait 2000

# Capture
agent-browser screenshot
agent-browser screenshot --full
agent-browser pdf output.pdf
```

## Common Patterns

### Form submission

```bash
agent-browser open https://example.com/signup
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser select @e3 "California"
agent-browser check @e4
agent-browser click @e5
agent-browser wait --load networkidle
```

### Authentication with state persistence

```bash
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "$USERNAME"
agent-browser fill @e2 "$PASSWORD"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Data extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e5
agent-browser get text body > page.txt
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

### Parallel sessions

```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com
agent-browser --session site1 snapshot -i
agent-browser --session site2 snapshot -i
agent-browser session list
```

### Visual browser debugging

```bash
agent-browser --headed open https://example.com
agent-browser snapshot -i
agent-browser highlight @e1
agent-browser record start demo.webm
```

### Local files

```bash
agent-browser open file:///path/to/document.pdf
agent-browser open file:///path/to/page.html
agent-browser screenshot output.png
```

### Mobile-style workflows

If your environment includes device emulation or a mobile browser harness, use
the same open -> snapshot -> interact -> re-snapshot rhythm there. Treat those
flows as provider-specific extensions rather than core `agent-browser` CLI
commands unless your local install documents them explicitly.

## Ref Lifecycle

Refs (`@e1`, `@e2`, and so on) are invalidated when the page changes. Always
re-snapshot after:

- clicking links or buttons that navigate
- form submissions
- dynamic content loading such as dropdowns or modals

```bash
agent-browser click @e5
agent-browser snapshot -i
agent-browser click @e1
```

## Semantic Locators

When refs are unavailable or unreliable, use semantic locators:

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## Deep-Dive References

| Reference                                                            | When to Use                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| [references/commands.md](references/commands.md)                     | Full command reference with all options                   |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | Ref lifecycle, invalidation rules, troubleshooting        |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md)         | Login flows, OAuth, 2FA handling, state reuse             |
| [references/video-recording.md](references/video-recording.md)       | Recording workflows for debugging and documentation       |
| [references/proxy-support.md](references/proxy-support.md)           | Proxy configuration, geo-testing, rotating proxies        |

## Ready-to-Use Templates

| Template                                                                 | Description                         |
| ------------------------------------------------------------------------ | ----------------------------------- |
| [templates/form-automation.sh](templates/form-automation.sh)             | Form filling with validation        |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | Login once, reuse state             |
| [templates/capture-workflow.sh](templates/capture-workflow.sh)           | Content extraction with screenshots |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
