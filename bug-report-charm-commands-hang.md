# Bug Report: ct charm commands hang indefinitely with background fetcher charms

## Summary

Commands like `ct charm new` and `ct charm setsrc` hang indefinitely (producing no output) when executed in a space that contains background fetcher charms (e.g., Gmail importers). The commands never complete and must be killed manually.

## Expected Behavior

`ct charm new` and `ct charm setsrc` should:
1. Compile the pattern
2. Create/update the charm
3. Return the charm ID or success message
4. Complete within a reasonable time (seconds to a minute)

## Actual Behavior

The commands hang indefinitely with:
- No output produced (status shows "running" but no stdout/stderr)
- Process never completes
- Must be manually killed with Ctrl+C or kill command
- No error messages or indication of what's blocking

## Reproduction Steps

1. Create a space with a background fetcher charm (e.g., Gmail importer pattern from `recipes/gmail-importer.tsx`)
2. Instantiate the Gmail importer: `ct charm new --space <space-name> recipes/gmail-importer.tsx`
3. Authenticate and let it fetch emails
4. Try to create a new charm in the same space: `ct charm new --space <space-name> some-pattern.tsx`
5. Observe that the command hangs indefinitely

Same behavior occurs with:
- `ct charm setsrc --space <space-name> --charm <charm-id> pattern.tsx`
- Possibly other charm mutation commands

## Commands Affected

Confirmed hanging:
- `ct charm new --space <space-name> <pattern.tsx>`
- `ct charm setsrc --space <space-name> --charm <charm-id> <pattern.tsx>`

Commands that work normally:
- `ct charm ls --space <space-name>`
- `ct charm inspect --space <space-name> --charm <charm-id>`
- `ct charm get --space <space-name> --charm <charm-id> <path>`
- `ct charm link --space <space-name> <source> <target>` (completes but may loop outputting status)

## Environment

- OS: macOS (Darwin 24.6.0)
- ct tool: Version 0.0.1 (compiled binary)
- Space: `alex-1027-gmail` (contains Gmail importer charms)
- Background fetcher charms: Gmail importer (`recipes/gmail-importer.tsx` with `recipes/gmail-auth.tsx`)

## Hypothesis

The issue appears to be specific to spaces containing background fetcher/polling charms:
- Gmail importer continuously polls Gmail API
- May be related to transaction conflicts or space locking
- Commands that modify the space (create/update charms) seem to wait for something that never completes
- Read-only commands work fine

## Workarounds

None found. Must use a different space without background fetcher charms for charm creation/updates.

## Impact

- Cannot create or update charms in spaces with background fetchers
- Severely limits ability to build integrated workflows with data importers
- Forces separation of data import spaces from data processing spaces

## Additional Notes

The `ct charm link` command also exhibits unusual behavior (infinite loop printing "emails X"), but does eventually establish the link successfully. The create/update commands never complete at all.
