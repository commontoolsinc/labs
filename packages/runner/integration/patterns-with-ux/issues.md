# Known Issues

## UI Rendering Issue (Affects multiple patterns)

When navigating to a charm URL that has `[NAME]` and `[UI]` exports, the web
interface shows "Create default recipe?" dialog. Clicking "Go!" creates a
DefaultCharmList instead of rendering the charm's UI. The charm itself is valid
and functional (verified via `ct charm inspect`), but the web UI doesn't
properly detect or render it.

Issue appears to be in the web frontend's charm detection/rendering logic, not
the recipe itself.

### Affected Patterns

**calendar-availability**

- Charm ID: `baedreieo3fou3qbn2w75d52vjuiwvag636qjtjxhxsy5aik43hqpsr3x4i`
- Space: `cal-avail-demo`
- All exports verified working via ct commands ✓

**counter-grouped-summary**

- Charm ID: `baedreicgjin33u5ovwslmjhzfeos6pzwci6kftng7rwxuauuokynng2ca4`
- Space: `test-grouped-summary`
- All exports verified working via ct commands ✓
- Tested with entries: computed summaries correctly (alpha: 15/2, beta: 15/1)
- Overall total: 30, dominant group: alpha (alphabetically tie-broken)
