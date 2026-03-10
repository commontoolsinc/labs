# Star Tracker: Stress-Testing `fetchData` at Scale

## What Is This

The **star tracker** is a pattern that tracks GitHub star counts and growth trends
for a list of repositories. It's a real, useful tool — but more importantly, it's
a **stress test for how patterns handle many concurrent fetches**.

**Branch:** `alex/star-tracker`
**Code:** `packages/patterns/star-tracker/star-tracker.tsx`
**Tests:** `packages/patterns/star-tracker/star-tracker.test.tsx`

## What It Does

- Accepts a list of GitHub repos (pasted as URLs, markdown, or `owner/repo`)
- For each repo: fetches repo info + samples 5 pages of stargazer timestamps
  from the GitHub API
- Renders sparkline growth charts using `ct-chart`, with growth analysis
  (accelerating / linear / decelerating)
- Click a sparkline to see a detail modal with a larger chart
- Sort by stars, growth rate, or name
- Paginated (25 repos at a time, "Show More" button)
- GitHub token via direct input or `wish` integration (`#githubToken`)

## Architecture

```
StarTracker (main pattern)
  ├── repos: Writable<RepoEntry[]>     — the list of tracked repos
  ├── visibleRepos: computed()          — paginated slice (first N)
  ├── repoCards: visibleRepos.map()     — sub-pattern per repo
  │     └── RepoCard (sub-pattern)
  │           ├── fetchData (repo info)      — 1 request
  │           └── fetchData × 5 (stargazer pages) — chained sequentially
  └── sortedCards: computed()           — reorders cards for display
```

Each `RepoCard` creates **6 fetchData calls**. With 25 visible repos, that's up
to **150 HTTP requests**.

## Finding 1: fetchData Caching Has a Race Condition on Page Reload

### Cell Identity Is Deterministic (Good)

The entity IDs for fetchData's cells (result, pending, error, internal) ARE
deterministic and stable across pattern restarts. The cause chain is:

1. `processCell.entityId` → deterministic from the pattern's result cell
2. `inputsCell.entityId` → data URI encoding the input bindings
3. Both are content-addressed hashes via `refer()` from `merkle-reference/json`

Same pattern + same recipe + same argument = same fetchData cell entity IDs.

### Same-Session Reload: Caching Works

Within a single browser session (navigating between patterns, code hot-reload),
caching works correctly:

- Cell data is retained in the in-memory Heap (part of the Replica)
- When fetchData runs again with the same entity IDs, it finds the old
  `internal.inputHash` matches, `result` is defined → `hasValidResult` is true
- **No re-fetch**

### Full Page Reload: Caching Fails Due to Race

On a full page reload, **all fetches re-fire** even though the data exists on
the memory server. Here's why:

1. Cells are created with deterministic entity IDs (same as before)
2. `sync()` kicks off an async pull from the memory server — **but is not
   awaited** (`fetch-data.ts:112-115`, comment says "Kick off sync in the
   background")
3. The action reads `internal.inputHash` synchronously in the same tick
4. **IDB cache is disabled** (`NoCache()` at `cache.ts:1826` — marked
   `FIXME(@ubik2): Disabling the cache while I ensure things work correctly`)
5. With no local cache, the schema default returns `inputHash: ""`, which
   doesn't match the computed hash → cache miss
6. fetchData starts a new fetch

Eventually the sync completes and the data arrives from the memory server, but by
then the redundant fetches are already in flight. The end result is correct (same
data), but **every page reload triggers a full burst of HTTP requests to the
external API**.

### Evidence

- **IDB disabled**: `packages/runner/src/storage/cache.ts` line 1822 —
  `new NoCache()` with `FIXME(@ubik2)`
- **sync not awaited**: `packages/runner/src/builtins/fetch-data.ts` lines 112-115
- **Schema defaults cause miss**: `packages/runner/src/builtins/fetch-utils.ts`
  lines 9-18, `inputHash` defaults to `""`

### What Would Fix This

1. **Re-enable IDB cache** — the `FIXME` disabling it is the single biggest issue
2. **Await sync before first action run** — gate on sync completion before
   checking the cache
3. **Add a fetch concurrency limiter** — as a safety net regardless

## Finding 2: No Concurrency Protection for Fetches

The runtime has **zero fetch-specific throttling**:

- No queue, no concurrency pool, no rate limiter, no backpressure
- Each `fetchData` action sets up an async `fetch()` and returns immediately
- The scheduler serializes the synchronous action bodies, but the actual HTTP
  requests are all fire-and-forget
- 100 different URLs = 100 concurrent HTTP requests, limited only by the
  browser's per-host connection pool (~6 for HTTP/1.1)

### What the Star Tracker Does to Work Around This

1. **Client-side pagination** — `PAGE_SIZE = 25` limits how many sub-patterns
   render
2. **Sequential fetch chaining** — each stargazer page URL returns `""` until
   the previous page completes:
   ```tsx
   const pageUrl1 = computed(() =>
     page0.result || page0.error ? starPageUrl(owner, repo, 1, stars) : ""
   );
   ```
   This turns 5 parallel requests/repo into a sequential chain, reducing the
   initial burst from ~150 to ~25.
3. **Estimated curve fallback** — uses a sqrt estimation from creation date when
   real stargazer data is sparse, avoiding unnecessary API calls

## Questions for the Team

### 1. Should the runtime have a fetch concurrency limiter?

A **semaphore in `fetch-data.ts`** that limits concurrent in-flight fetches
(e.g., max 6-10 globally) would protect all patterns automatically. The
sequential-chaining hack we built is clever but brittle and pattern-specific.

**Where this would go:** `packages/runner/src/builtins/fetch-data.ts`, around
the `fetch()` call at line ~287.

### 2. When will IDB cache be re-enabled?

The `FIXME(@ubik2)` disabling IDB cache means every page reload re-fetches
everything. For patterns with many fetches (or expensive LLM calls), this is a
significant regression. What's blocking re-enabling it?

### 3. Should fetchData await sync before checking cache?

The fire-and-forget `sync()` in fetchData means the first action run always sees
empty cells. Would it be safe to await sync (or at least gate on it) before
deciding whether to re-fetch? The tradeoff is slightly slower first render vs.
avoiding redundant fetches.

### 4. What about `fetchData` options for caching behavior?

Currently there's no way to express "this URL's response never changes" or
"re-fetch after 1 hour." Possible API:

```tsx
fetchData({
  url: repoUrl,
  mode: "json",
  cache: "immutable",      // never re-fetch for same URL
  // or: ttl: 3600,        // re-fetch after 1 hour
});
```

### 5. How should this work for LLM calls?

The same problems apply to `generateText` / `generateObject`. If a pattern maps
over 50 items and calls an LLM for each, that's 50 concurrent API calls. LLM
calls are more expensive (cost and latency) and more likely to hit rate limits.

Should there be a shared concurrency model across `fetchData` and LLM calls? Or
separate limiters?

### 6. Is index-based sub-pattern identity the right model?

The `.map()` builtin uses **index-based identity** (not content-based). This
means:
- Appending to the list is cheap (only new indices get new sub-patterns)
- Reordering the input array shuffles internal state between sub-patterns
- No garbage collection when the list shrinks (sub-patterns stay alive)

We work around this by sorting at the **view layer** (`sortedCards` reorders
output references, not the `.map()` input). But should there be a keyed `.map()`
(like React's `key` prop)?

### 7. What's the long-term vision for data-heavy patterns?

As patterns get more ambitious (dashboards, aggregators, research tools), the
"sub-pattern per item, each with its own fetches" model will be common. What's
the architectural plan for:
- Fetch concurrency management
- Batch/bulk API support (e.g., GraphQL queries for multiple items)
- Progressive loading primitives (beyond hand-rolled pagination)
- Cache invalidation / refresh strategies
