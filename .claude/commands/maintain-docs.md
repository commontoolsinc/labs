# Maintain Documentation

This command helps maintain the accuracy of the CT documentation by comparing the ct.md file with the actual CLI help output and identifying discrepancies.

## What this command does:

1. **Reads ct.md** - Loads the current documentation file
2. **Rebuilds the CT binary** - Ensures we're checking against the latest version
3. **Runs help commands** - Executes various `--help` commands to get actual CLI documentation
4. **Compares documentation** - Identifies discrepancies between ct.md and actual help output
5. **Offers fixes** - Proposes updates to fix any inconsistencies found

## How to use:

Simply ask to "maintain docs" or "check ct documentation" and the command will:
- Analyze all command signatures and examples
- Check for missing or outdated commands
- Verify parameter descriptions match
- Ensure examples are up-to-date

## Commands checked:

The following ct commands will be verified:
- `ct charm ls`
- `ct charm new`
- `ct charm link`
- `ct charm inspect`
- `ct charm getsrc`
- `ct charm setsrc`
- `ct charm apply`
- `ct charm map`
- `ct dev`

## What gets verified:

- Command syntax and usage patterns
- Parameter names and descriptions
- Example commands and their descriptions
- Environment variable documentation
- Any new commands not yet documented

## Example usage:

```
User: maintain the ct docs
Assistant: I'll check the ct.md documentation against the actual CLI help output...

[Rebuilds binary, runs help commands, compares with documentation]

Found the following discrepancies:
1. The `getsrc` command now outputs to a folder, but docs show single file
2. New `--main-export` parameter not documented for `setsrc`
3. Missing documentation for new `ct charm map` command

Would you like me to update the documentation to fix these issues?
```