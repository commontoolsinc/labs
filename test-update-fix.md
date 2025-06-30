# Multi-file Editor Update Fix

## Problem
The "Update Existing" button in jumble was creating new charms instead of updating in place, while the CLI's `set-src` command correctly updated existing charms.

## Root Cause
In `use-multi-file-editor.ts`, the `saveChanges` function had three code paths:
1. **iframe recipes** - Correctly respected the `createNew` parameter ✓
2. **single-file regular recipes** - Always created new charms (ignored `createNew`) ✗
3. **multi-file recipes** - Always created new charms (ignored `createNew`) ✗

## Solution
Updated the single-file and multi-file code paths to check the `createNew` parameter:

### Single-file regular recipes:
- When `createNew=true`: Use `compileAndRunRecipe` (creates new charm)
- When `createNew=false`: Use `compileRecipe` + `runWithRecipe` (updates in place)

### Multi-file recipes:
- When `createNew=true`: Use `runPersistent` (creates new charm)
- When `createNew=false`: Use `compileRecipe` + `runWithRecipe` (updates in place)

## Testing
To test the fix:
1. Create or edit a multi-file charm in jumble
2. Click "Update Existing" - should update the same charm
3. Click "Save as New" - should create a new charm and navigate to it

The fix ensures all recipe types (iframe, single-file, multi-file) properly respect the user's choice between updating existing or creating new charms.