# Platform Tour

Interactively tour the Common Tools platform as a user, exercising core workflows through browser automation. You are LARPing as a curious user exploring the platform. Narrate what you see as you go — the user is watching.

## Usage

```
/tour <base-url>
```

If no URL is provided, default to `http://localhost:8000`. Examples:
- `/tour` — local dev server
- `/tour https://toolshed.saga-castor.ts.net` — production

## Setup

1. **Determine the base URL.** Use `$ARGUMENTS` if provided, otherwise `http://localhost:8000`. Trim any trailing slash.

2. **Compute the space slug.** Use today's date in `YYYY-MM-DD` format plus `-claude` (e.g. `2026-02-16-claude`).

3. **Create a screenshot directory.** Create `./tour-screenshots/YYYY-MM-DD/` for this run. All screenshots go here with numbered prefixes and descriptive names (`01-space-home.png`, `02-new-note.png`, etc.).

4. **Detect browser automation tool.** Run `which agent-browser` to check availability.

   **If `agent-browser` is available:** Use it throughout. Open with `agent-browser --headed open {url}` so the user can watch. Use `agent-browser snapshot -i` to discover interactive elements, interact via `@ref`s, and `agent-browser screenshot {path}` to capture.

   **If `agent-browser` is NOT available:** Fall back to the Playwright MCP tools. Use `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_take_screenshot` instead. The same principles apply — snapshot before interacting, use refs from snapshots, re-snapshot after DOM changes.

5. **Navigate to the space.** Open `{base-url}/{space-slug}`. Take an initial snapshot and screenshot. Describe what you see.

## The Tour

Work through these steps in order. At each step:
- Take a snapshot to discover interactive elements
- Interact using refs from the snapshot — never hardcode selectors
- After each major action, re-snapshot (refs are invalidated by DOM changes)
- Take a screenshot and save it to the screenshot directory
- **Narrate what you see** — describe the UI, what changed, anything surprising
- If a step fails, note the failure, take a screenshot of the error state, and continue to the next step

### Step 0: Register / Login

Fresh spaces require authentication. You will see "Register" and "Login" buttons on the landing page.

- Click **Register** to create a new identity
- Click **Generate Passphrase** on the next screen
- Click **I've Saved It - Continue** to complete registration

If the space is already authenticated (you see the Patterns view with a header toolbar), skip this step.

### Step 1: Explore the Space Home

You should now be on the authenticated space page. Describe the layout: the header breadcrumb, the "Patterns" heading, the "Notes" dropdown, any toolbar buttons, and the FAB (floating action button) in the bottom-right. Take a screenshot.

### Step 2: Create a New Note

Find the **"Notes ▾"** dropdown button in the content toolbar area. Click it to reveal a menu with options like "New Note", "New Notebook", "All Notes". Click **"New Note"**. After the note view loads, take a screenshot.

### Step 3: Edit the Note

The note has two parts to edit:

**Title:** The title (e.g. "New Note") is displayed as a text heading, NOT as an input field. To edit it, **double-click** on the title text. This requires coordinate-based clicking:
1. Use JS eval to find the title element and get its bounding box coordinates
2. Use `mouse move {x} {y}` followed by two rapid `mouse down left` / `mouse up left` pairs to double-click
3. A textbox labeled "Note title..." will appear — fill it with today's date

**Body:** There is a textbox (code editor) for the note content. Click it and type a message like: "Hello from Claude's tour on {date}. This note was created during an automated platform walkthrough."

Take a screenshot showing the edited note with the updated title in the breadcrumb.

### Step 4: Return to Space Home

Click the space name link in the breadcrumb (e.g. "2026-02-16-claude") to navigate back to the space home. Verify the note you created appears in the Patterns list with its title. The breadcrumb should show an updated item count. Take a screenshot.

### Step 5: Open the Chat

Find the **"Open" button** (the FAB) in the bottom-right corner of the page and click it. A chat panel will appear in the bottom-right with:
- An input field: "Ask the LLM a question..."
- A "Send" button
- A model selector (defaults to Claude Opus)
- "Tools" button showing available tool count
- An "Expand" button to make the panel larger

Click Expand for better visibility. Take a screenshot.

### Step 6: Reference the Note in Chat

1. Click into the chat input textbox
2. Type `@` to trigger the mention autocomplete — a dropdown list will appear
3. Find and click your note (e.g. "📝 2026-02-16") in the dropdown
4. The mention will be inserted as a markdown link in the input
5. Type after the mention: " What does this note say?"
6. Click Send and wait ~15 seconds for the LLM to respond

The LLM should use the `read` tool and quote the note's content back. Take a screenshot of the response.

### Step 7: Ask for the Pattern Index

In the chat, type: "Can you list the available patterns from the pattern index?" and send. Wait ~20 seconds. The LLM should use the `listPatternIndex` tool and return categorized lists of available patterns. Take a screenshot.

### Step 8: Launch a Counter Pattern

In the chat, type: "Please launch the counter pattern with an initial value of 5" and send. Wait ~25 seconds. The LLM should:
1. Use `fetchAndRunPattern` to compile and run the counter
2. Use `navigateTo` to navigate to the new pattern

The counter view shows: a heading "Simple Counter", a large number (5), text like "Counter is the 5th number", and "- Decrement" / "+ Increment" buttons. Take a screenshot.

**Testing interactivity:** The counter buttons are custom `ct-button` web components. Ref-based clicks (`agent-browser click @ref`) may hang on these elements. Use coordinate-based clicking instead:
1. Use JS eval to walk the shadow DOM and find the button's bounding box
2. Use `mouse move {x} {y}` + `mouse down left` + `mouse up left` to click
3. Verify the counter value updates

Take a screenshot showing the changed value.

## Bonus Exploration

After completing the core tour, you are encouraged to explore further. Some ideas:
- Try launching another pattern from the index (e.g. a checklist or summary)
- Test the counter's decrement button
- Navigate back to the space home and see all created pieces
- Check for any other interactive elements on the page
- Check console errors with `agent-browser console`
- Try navigating to different views

Spend 2-3 minutes exploring, then wrap up.

## Wrap Up

1. **Check for errors.** If using `agent-browser`, run `agent-browser console` and `agent-browser errors` to capture any console errors or warnings. If using Playwright MCP, check the browser console via `browser_console_messages`.

2. **Take a final screenshot** of the current state.

3. **Print the tour report:**

```
## Tour Report - {date}

### Environment
- URL: {base-url}
- Space: /{space-slug}
- Browser tool: agent-browser | playwright MCP

### Steps Completed
For each step, mark pass/fail with a one-line observation:
- [x] Registration — how the auth flow went
- [x] Space Home — description of what loaded
- [x] Create Note — how it went
- [x] Edit Note — title and body editing
- [ ] Some Step — FAILED: reason
...etc

### Screenshots
List all saved screenshots with paths.

### Console Errors
Any errors or warnings found in the browser console.

### Issues Found
Describe any bugs, unexpected behavior, or UX friction encountered.

### Bonus Exploration
What else you tried and what you observed.
```

4. **Ask the user if they want to keep exploring.** Use AskUserQuestion to offer:
   - **Explore more patterns** — keep the browser open and let the user pick patterns from the index to launch and try
   - **Done** — close the browser and end the tour

If the user chooses to explore more patterns, list the patterns from the index (from Step 7's response) and ask which one to launch. Keep iterating — launch the pattern, narrate what it does, take screenshots, then ask again. Close the browser only when the user says they're done.

## Known Gotchas

These were discovered during the first tour run and should be expected:

1. **Double-click for title editing.** The note title is not an interactive element in the accessibility tree. You must double-click it using coordinate-based mouse events to make it editable.

2. **`ct-button` clicks may hang.** Custom web component buttons (like the counter's increment/decrement) can cause `agent-browser click @ref` to hang indefinitely. Use coordinate-based clicking as a workaround: find the element's bounding box via JS eval, then use `mouse move` + `mouse down/up`.

3. **Counter not in `listPatternIndex`.** The counter pattern may not appear in the index listing, but the LLM can still launch it via `fetchAndRunPattern` using the path `counter/counter.tsx`.

4. **LLM response times.** Chat responses take 15-25 seconds, especially for tool-using responses. Use appropriate wait times.

5. **Font warnings.** You may see JetBrainsMono font OTS parsing warnings in the console — these are cosmetic and not errors.

## Rules

- **Prefer `agent-browser`, fall back to Playwright MCP.** Check availability at startup and adapt.
- **Always snapshot before interacting.** Never assume element refs from a previous snapshot are still valid.
- **Be descriptive.** The user is watching — narrate what you see, what you're clicking, and what happened.
- **Don't block on failures.** If a step fails, document it and move on. The tour is about coverage, not perfection.
- **No hardcoded selectors.** Discover elements from snapshots. The UI may change — the Known Gotchas describe interaction patterns, not specific refs.
- **Show the browser.** Use headed/visible mode so the user can watch the tour happen in real time.
- **This is exploratory, not a snapshot test.** The descriptions are high-level guides. You are free to explore beyond the prescribed steps and adapt to what you find.
- **Use coordinate-based clicks for custom web components.** When `agent-browser click @ref` hangs, fall back to finding the element via JS eval and clicking at its coordinates.
