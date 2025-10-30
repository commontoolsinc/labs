# Transaction Rollup

A TypeScript utility for condensing large transaction journal and result files into concise, LLM-friendly summaries for debugging.

## Problem

Transaction details in the storage system can be extremely verbose:
- `journal.json`: ~40,000 tokens (detailed activity log)
- `result.json`: ~30,000 tokens (commit data)

This makes it challenging for LLMs to help debug transactions when the raw data exceeds context limits.

## Solution

The transaction rollup parser extracts and condenses the most relevant information:
- What changed (field paths and values)
- Handler invocation detection
- User-facing charm references
- Activity summary (reads/writes)
- Optional: link resolutions and complex values

Result: ~500-1000 tokens instead of 70,000+

## Quick Start

```bash
# Basic usage
deno run --allow-read tx-rollup.ts <journal.json> <result.json>

# Run examples
deno run --allow-read tx-rollup-example.ts minimal
deno run --allow-read tx-rollup-example.ts llm
```

## Example Output

**Before (70,000+ tokens):**
```json
{
  "activity": [
    {
      "read": {
        "path": ["value", "/", "link@1"],
        "id": "data:application/json,%7B%22value%22%3A...",
        ...
      }
    },
    ... 48 more entries
  ],
  "ok": {
    "did:key:z6MktCfW...": {
      "application/commit+json": {
        ...massive nested structure...
      }
    }
  }
}
```

**After (~100 tokens):**
```
Handler was called. Command: /memory/transact.
User charm: baedreigx4zh....
Changed: argument.title → "New Notek", argument.content → "12345".
Activity: 1 write(s), 48 read(s)
```

## API Usage

```typescript
import {
  createTransactionRollup,
  loadTransactionDetails,
} from "./tx-rollup.ts";

// Load transaction files
const { journal, result } = await loadTransactionDetails(
  "./tx-details/journal.json",
  "./tx-details/result.json"
);

// Create rollup with options
const rollup = createTransactionRollup(journal, result, {
  includeReads: true,              // Include read operations
  includeComplexValues: false,     // Skip nested objects
  maxValueLength: 100,             // Truncate long strings
  includeLinkResolutions: true,    // Include link references
});

console.log(rollup.summary);
```

## Rollup Output Structure

```typescript
interface TransactionRollup {
  summary: string;                    // Human-readable summary
  command: string;                    // Transaction command
  changes: ChangesSummary[];         // Field changes
  activity: ActivitySummary;         // Read/write stats
  objectsChanged: number;            // Count of modified objects
  includesHandlerCall: boolean;      // Handler detection
  userFacingCharm?: string;          // User charm ID
  linkResolutions?: LinkResolution[]; // Optional link refs
}
```

## Configuration Options

### `includeReads` (default: `true`)
Include read operations in the activity summary. Useful for understanding what data was accessed during the transaction.

```typescript
{
  includeReads: true,
  // Result includes uniquePathsRead array
}
```

### `includeComplexValues` (default: `false`)
Include complex nested objects in field changes. Usually not needed for debugging.

```typescript
{
  includeComplexValues: true,
  // Includes objects and arrays in changedFields
}
```

### `maxValueLength` (default: `100`)
Truncate string values longer than this length to keep output concise.

```typescript
{
  maxValueLength: 50,
  // "very long string..." will be truncated
}
```

### `includeLinkResolutions` (default: `false`)
Include information about link resolutions (references between objects).

```typescript
{
  includeLinkResolutions: true,
  // Result includes linkResolutions array
}
```

## Example Workflows

### 1. Quick Debug Summary
```bash
deno run --allow-read tx-rollup.ts journal.json result.json
```

Shows:
- What changed
- Handler invocation status
- User-facing charm
- Basic activity stats

### 2. Detailed Investigation
```typescript
const rollup = createTransactionRollup(journal, result, {
  includeReads: true,
  includeLinkResolutions: true,
});

console.log("Reads:", rollup.activity.uniquePathsRead);
console.log("Links:", rollup.linkResolutions);
```

### 3. LLM Debugging Session
```typescript
// Create LLM-optimized prompt
const prompt = `
Debug this transaction:

${rollup.summary}

Changed fields:
${rollup.changes.flatMap(c =>
  c.changedFields.map(f => `- ${f.path} = ${f.newValue}`)
).join("\\n")}

What could cause the content field to change unexpectedly?
`;
```

## Understanding the Output

### Handler Detection
The rollup automatically detects if a handler was called by looking for:
- Event stream patterns (`$event`, `$stream`)
- Write operations
- Handler-specific path patterns

### Field Changes
Shows the **new** values after the transaction. For example:
- `argument.content → "12345"` means content was set to "12345"

Note: Old values are not currently included in the result data, so we show the new state.

### Object IDs
- **objectId**: The internal storage ID (e.g., `of:baedreicda...`)
- **resultRef**: The user-facing charm ID (e.g., `of:baedreigx4zh...`)

### Activity Patterns
Common patterns to look for:
- High read count: Data-intensive operation or complex queries
- Single write: Simple field update (like our example)
- Multiple writes: Batch operation or cascading changes

## Integration with LLM Tools

The rollup is designed to be easily integrated into LLM-assisted debugging workflows:

1. **As a standalone summary:** Run the rollup and copy the output
2. **As structured JSON:** Export the rollup object for programmatic use
3. **As a prompt template:** Use the example formats to create debugging prompts

## Future Enhancements

Potential additions:
- [ ] Old value extraction (if available in transaction data)
- [ ] Handler code snippet extraction
- [ ] Diff visualization between before/after states
- [ ] Transaction chain analysis (multiple related transactions)
- [ ] Performance metrics (timing, size)
- [ ] Error/warning detection

## Architecture Notes

### Data Flow
```
journal.json + result.json
    ↓
loadTransactionDetails()
    ↓
createTransactionRollup()
    ↓
TransactionRollup
```

### Key Functions
- `summarizeActivity()`: Processes read/write operations
- `summarizeChanges()`: Extracts field changes from result
- `detectHandlerCall()`: Pattern-matches handler invocation
- `extractUserFacingCharm()`: Finds the resultRef ID
- `extractLinkResolutions()`: Identifies object references

## Troubleshooting

### "No changes detected"
- Check that the result.json contains the `changes` object
- Verify the path to `value.argument` exists

### "Handler not detected"
- May indicate a direct write without handler invocation
- Check for `$event` or `$stream` patterns in the journal

### "UserFacingCharm is undefined"
- The resultRef may be in a different location
- Try enabling `includeComplexValues` to see full structure

## License

Part of the CommonTools labs project.
