<!-- @reviewed 2026-02-06 wish-result-shape -->

# wish()

`wish()` discovers and connects to other pieces at runtime. It searches
favorites and/or mentionables by tag, and returns a reactive `WishState<T>`.

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Result Shape

`wish()` returns a `WishState<T>` with the following properties:

| Property     | Type    | Description                                           |
|--------------|---------|-------------------------------------------------------|
| `result`     | `T`     | The resolved piece (auto-confirmed or user-selected)  |
| `candidates` | `T[]`   | All matching pieces                                   |
| `[UI]`       | `VNode` | Built-in UI: picker (multiple matches) or result cell |
| `error`      | `any`   | Error message if resolution failed                    |

Access the resolved piece via `wishResult.result`:

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });

// Read a property from the resolved piece
const text = wishResult.result.content;

// Render the resolved piece's own UI
return { [UI]: <div>{wishResult.result}</div> };
```

### Single match auto-confirms

When exactly one piece matches, `result` is set immediately with no picker
shown. The `candidates` array will contain that single item.

### Multiple matches show a picker

When multiple pieces match, a picker UI is rendered via `wishResult[UI]`. The
user browses candidates and clicks "Confirm Selection". Until confirmed,
`result` reactively reflects the currently highlighted candidate.

You can render the built-in UI directly:

```tsx
return { [UI]: <div>{wishResult}</div> };
```

## Wishing for a Specific Piece

Decorate your schema with a jsdoc comment containing a `#tag`:

```tsx
/** Represents a small #note a user took to remember some text. */
type Output = {
  content: Default<string, "">;
};
```

Then wish for that tag from another pattern:

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Scope Parameter

The `scope` parameter controls where wish searches for matching pieces:

- `"~"` - Search favorites in the [[HOME_SPACE]] (global, cross-space)
- `"."` - Search [[mentionable]] items in the current space

By default (no scope), wish searches **favorites only** for backward
compatibility.

### Examples

```tsx
// Search only favorites (default behavior)
wish({ query: "#note" })
wish({ query: "#note", scope: ["~"] })

// Search only mentionables in current space
wish({ query: "#note", scope: ["."] })

// Search both favorites AND mentionables (favorites first)
wish({ query: "#note", scope: ["~", "."] })
```

### Favorites vs Mentionables

| Feature    | Favorites (`~`)           | Mentionables (`.`)              |
|------------|---------------------------|---------------------------------|
| Storage    | Home space (global)       | Current space                   |
| Scope      | Cross-space               | Per-space                       |
| Source     | User's favorites list     | Pattern's `mentionable` export  |
| Tag source | Snapshotted when favorited| Computed from schema            |

### When to Use Each Scope

- **Favorites only (default)**: Globally available pieces the user has explicitly saved
- **Mentionables only**: Space-specific features that discover pieces created within that space
- **Both**: Find any relevant piece regardless of where it lives

## Call wish() at Pattern Level

Always call `wish()` at the pattern body level, not inside `computed()` or other
reactive constructs:

```tsx
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchPiece = wish<SearchOutput>({ query: "#search" });

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return searchPiece.result?.data;
  });

  return { searchData, [UI]: <div>{searchData}</div> };
});
```

This ensures the wish is established once. Conditional logic belongs in how you
*use* the result, not in whether you *create* the wish.

## Built-in Targets

Some wish targets resolve to built-in runtime data rather than searching for
pieces.

### `#now` — Current Timestamp (one-shot)

Returns the current time as a millisecond timestamp, captured once when the
pattern runs. Useful for "created at" or "last opened" timestamps.

```tsx
const createdAt = wish({ query: "#now" });
// createdAt.result is a number like 1708000000000
```

The timestamp is coarsened to 1-second resolution (always ends in `000`). This
is defense-in-depth: once SES sandboxing is enforced, `Date.now()` will be
blocked in patterns, and coarsening prevents timing side-channel attacks via this
API.

### `#now/N` — Reactive Interval Timestamp

Returns a reactive timestamp that updates every N milliseconds. The interval
goes in the path slot: `#now/60000` ticks every minute.

```tsx
const now = wish<number>({ query: "#now/5000" }); // ticks every 5s

const timeAgo = computed(() => {
  const ms = now.result - message.sentAt;
  return `${Math.floor(ms / 60000)} minutes ago`;
});
```

**Behavior:**

- The returned cell updates reactively — downstream `computed()` values
  automatically re-evaluate on each tick
- Timestamps are coarsened to the interval boundary (e.g. `#now/5000` values are
  always divisible by 5000)
- Minimum interval is **1000ms** — values below are clamped to 1 second
- Timers are aligned to wall-clock boundaries (a 60s timer ticks at :00, :01,
  :02 of each minute)
- Cleanup is automatic when the pattern stops

**Common intervals:**

| Query            | Interval | Use case                    |
|------------------|----------|-----------------------------|
| `#now/1000`      | 1 second | Live clocks, countdowns     |
| `#now/5000`      | 5 seconds| "Just now" / "5s ago" labels|
| `#now/60000`     | 1 minute | "3 minutes ago" timestamps  |
| `#now/3600000`   | 1 hour   | "2 hours ago" displays      |

**Error cases:**

- `#now/abc` — error: interval must be a finite positive number
- `#now/0`, `#now/-1` — error: interval must be positive
- `#now/Infinity` — error: interval must be finite
- `#now/5000/extra` — error: too many path segments

### Other Built-in Targets

| Target          | Description                              |
|-----------------|------------------------------------------|
| `/`             | Current space cell                       |
| `/path/to/prop` | Nested property of the space cell        |
| `#default`      | Default pattern of the current space     |
| `#favorites`    | User's favorites list (from home space)  |
| `#recent`       | Recently-used pieces in the current space|
| `#allPieces`    | All pieces in the current space          |
| `#mentionable`  | Mentionable pieces in the current space  |

## Intended Usage

Keep a handle to important information in a piece, e.g. google auth, user
preferences/biography, cross-cutting data (calendar).
