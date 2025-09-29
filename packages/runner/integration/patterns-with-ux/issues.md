# Known Issues

## calendar-availability

When navigating to a charm URL that has `[NAME]` and `[UI]` exports, the web
interface shows "Create default recipe?" dialog. Clicking "Go!" creates a
DefaultCharmList instead of rendering the charm's UI. The charm itself is valid
and functional (verified via `ct charm inspect`), but the web UI doesn't
properly detect or render it.

Charm ID: `baedreieo3fou3qbn2w75d52vjuiwvag636qjtjxhxsy5aik43hqpsr3x4i` Space:
`cal-avail-demo`

The charm exports are correct:

- `$NAME`: "Calendar (2 slots)" ✓
- `$UI`: JSX component ✓
- All derived cells working correctly ✓

Issue appears to be in the web frontend's charm detection/rendering logic, not
the recipe itself.
