# Astral integration

Common Tools uses the published `@astral/astral` package. The root import map
pins version 0.5.6. The repository does not carry a copy of Astral's source.

## Local compatibility code

Common Tools keeps its application-specific browser behavior at the integration
boundary:

| Behavior | Common Tools owner | Published Astral surface |
| --- | --- | --- |
| Query open shadow roots with `strategy: "pierce"` | `packages/integration/astral-adapter.ts` | Raw page protocol bindings and the public `ElementHandle` constructor |
| Wait for a matching shadow element | `packages/integration/astral-adapter.ts` | Raw page protocol bindings |
| Observe clicks and typing for presentation recordings | `packages/integration/page.ts` | `ElementHandle`, page mouse, and page keyboard |
| Apply a default per-character typing delay | `packages/integration/page.ts` | Keyboard's per-call `delay` option |
| Treat an already-exited browser process as closed | `packages/integration/astral-adapter.ts` | Published browser lifecycle |
| Start and acknowledge screencast frames | `packages/integration/page.ts` | Raw page protocol bindings |
| Capture a Deno inspector CPU profile | `packages/cli/support/profiling/inspector-protocol-client.ts` | Chrome DevTools Protocol over the inspector WebSocket |

The pierce strategy retains the repository's existing selector semantics. It
searches elements inside open shadow roots and excludes matching elements in
the light DOM. Immediate `$` and `$$` calls perform one query. A
`waitForSelector` call observes DOM, selector state, and shadow-root changes in
the page and resolves when a match appears. The event-driven wait has no
elapsed-time deadline. Protocol shadow-root notifications cover roots attached
through a cached or replaced `attachShadow` function. Common form-control state
setters trigger a selector check directly. Closing the page rejects pending
waits and skips protocol cleanup that can no longer complete.

The inspector profiler has its own small protocol client because Astral does
not publish its generated protocol client as a package export. The profiler
uses only the Console, Debugger, Profiler, and Runtime methods it needs.

## Updating Astral

Update the version in the root `deno.jsonc`, refresh `deno.lock`, and run:

```sh
deno test -A packages/integration/test/astral-adapter.test.ts
deno test -A packages/cli/support/profiling/inspector-protocol-client.test.ts
deno test -A packages/cli/support/profiling/capture-deno-inspector-profile-lib.test.ts
deno fmt --check
deno lint
```

The focused integration test covers native and shadow-root selection, dynamic
element and selector-state changes, shadow roots attached after a wait starts,
browser lifecycle compatibility, interaction callbacks, transformed element
coordinates, and the default typing delay.

## Upstream history

[Astral pull request 166](https://github.com/lino-levan/astral/pull/166)
proposed shadow-root selector support on July 22, 2025. The maintainer asked for
an options-based API. The maintainer then approved the revised API, in which
the `strategy` option is either `native` or `pierce`. There was no formal
review or merge. The last discussion was July 31, 2025, and the pull request
remained open and mergeable on July 24, 2026.

The pull request's macOS check passed. Its Linux and Windows checks ended after
ten minutes in tests that depended on `example.com`. The proposed local test
server was split into
[Astral pull request 167](https://github.com/lino-levan/astral/pull/167),
which also remained open. Common Tools does not depend on either pull request.
