# Fabric iframe bridge

`@commonfabric/iframe-sandbox` runs guest HTML in a double-iframe sandbox and
connects it to an explicit set of host capabilities. The host describes named
resources; the guest discovers and uses only those resources.

> [!CAUTION]
> This remains experimental sandboxing. Review the security considerations below
> before exposing sensitive data or accepting third-party guest code.

## Host API

Give each element its own bridge. There is no process-global handler and no
ambient access to host state.

```ts
import {
  createFabricBridge,
  type FabricBridge,
} from "@commonfabric/iframe-sandbox";

let count = 0;
const listeners = new Set<(value: number) => void>();

const bridge: FabricBridge = createFabricBridge({
  count: {
    kind: "cell",
    schema: { type: "number", description: "Shared counter" },
    cell: {
      get: () => count,
      pull: () => count,
      set: (value) => {
        count = value as number;
        for (const listener of listeners) listener(count);
      },
      sink: (listener) => {
        listener(count);
        listeners.add(listener as (value: number) => void);
        return () => listeners.delete(listener as (value: number) => void);
      },
    },
  },
});

const frame = document.createElement("common-iframe-sandbox");
frame.bridge = bridge;
frame.src = "<main id='root'></main>";
```

A resource has a `kind`, optional schema and description, and only the
operations the host supplies. A cell capability follows the runtime's Cell
shape: `get()`, `pull()`, optional `set()` and `push()`, `sink()`, `key()`, and
`resolve()`. The resource kinds are `cell`, `stream`, `sqlite`, and `service`.
Named methods let an application expose a narrow service without expanding the
cell protocol.

The higher-level `cf-iframe` component accepts the same `bridge` property. Its
`context` convenience property turns top-level Fabric cells into cell resources,
read-only cells into resources without `set`, stream cells into `send`
resources, and SQLite database cells into `query`/`exec` resources. A pattern
can supply a serializable capability hint when a context cell's schema is
intentionally opaque at the renderer boundary:

```tsx
<cf-iframe
  src={guestHtml}
  $context={context}
  resourceKinds={{ appDatabase: "sqlite" }}
/>;
```

`resourceKinds` is a narrow manifest of `cell`, `readonly`, `stream`, or
`sqlite` kinds. It does not grant access to another cell: each name must still
be present in the bound context, and the bridge resolves that cell's concrete
scope before the guest loads.

## Guest API

The guest connects once and receives a Cell-shaped client. Remote operations
return promises; calls made before the document receives its `MessagePort`
remain queued in order.

```ts
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const manifest = await fabric.describe();
console.log(manifest.resources);

const count = fabric.cell<number>("count");
console.log(count.get()); // Immediate cache sample; it may be stale.
console.log(await count.pull()); // Fully updated after the host Cell.pull().
await count.set(1);

const stop = count.sink((value) => {
  console.log(value);
});

// When the application unmounts:
stop();
fabric.disconnect();
```

`sink()` calls its listener synchronously with the same cache sample `get()`
would return, then calls it when the host cell changes. `pull()` is the explicit
freshness boundary; it waits for the runtime Cell pull, including scheduler and
storage work that pull must settle. The bridge does not substitute a lighter
readiness probe for that contract.

`describe()` makes the API inspectable by people and agents. It returns every
resource's kind, core operations, named methods, description, and schema.
Missing resources and unsupported operations reject with `FabricBridgeError`,
whose `code` and `resource` fields are stable machine-readable context.

### Paths and stable array entries

`key()` derives a fine-grained cell view locally. Pulls, sinks, and writes carry
that path to the host, so a sink on `profile.key("name")` does not subscribe to
the whole profile.

An array position is not an item identity. Resolve the position before keeping a
sink or set handle when the item can move:

```ts
const tasks = fabric.cell<Array<{ title: string; done: boolean }>>("tasks");
await tasks.pull();

const task = await tasks.key(0).resolve();
console.log(task.identity?.id); // Stable entity document ID.

const stop = task.key("title").sink((title) => console.log(title));
await task.key("done").set(true); // Still the same task after array reorder.
```

The host mints an opaque capability for the resolved cell. The guest receives
identity metadata for keys and diagnostics, but cannot turn an arbitrary ID into
authority. `Cell.for(cause)` remains the runtime's construction API for a new
deterministic cell; it is not an array selector. Existing array objects are
anchored into entity documents, which is why resolving a positional item can
return a stable handle.

Use operation-shaped writes when they express the intent. `push()` carries only
the appended members and uses the runtime's mergeable append instead of reading
and replacing the array:

```ts
await tasks.push({ title: "Review bridge", done: false });
```

## React

The React adapter takes the React instance already used by the guest, so this
package does not impose or duplicate a React version. `useCell` is built on
`useSyncExternalStore`; it exposes a status snapshot, a setter that accepts a
value or updater function, and an explicit refresh.

```tsx
import React from "react";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { createFabricReact } from "@commonfabric/iframe-sandbox/react";

const fabric = connectFabric();
const { useCell, useSqliteQuery } = createFabricReact(React, fabric);

export function App() {
  const count = useCell<number>("count");
  const notes = useSqliteQuery<{ id: number; title: string }>(
    "appDatabase",
    "SELECT id, title FROM notes ORDER BY id DESC",
  );

  if (count.status !== "ready" || notes.status !== "ready") return <>Loading</>;
  return (
    <>
      <button onClick={() => count.set((value) => value + 1)}>
        {count.value}
      </button>
      <ul>{notes.rows.map((note) => <li key={note.id}>{note.title}</li>)}</ul>
    </>
  );
}
```

SQLite query hooks subscribe to the database resource's invalidation stream, so
a committed `exec` refreshes active queries.

## SQLite

SQLite is a resource on the same bridge rather than a separate transport.

```ts
const database = fabric.sqlite("appDatabase");

const { rows } = await database.query<{ id: number; title: string }>(
  "SELECT id, title FROM notes WHERE archived = ?",
  [false],
);

await database.exec(
  "INSERT INTO notes (title) VALUES (:title)",
  { title: "Bridge the database" },
);

const stopInvalidations = database.sink(() => {
  console.log("database changed");
});
```

`exec` uses the runner's transactional SQLite path, including its write checks,
commit conflict handling, and database revision update. Direct bridge queries
are available for unlabeled databases. A database whose schema needs CFC column
provenance is refused because the direct response has no Fabric result cell on
which to persist derived labels; query that database inside a pattern instead.

The same `cf-iframe-bridge-multi-user.test.ts` multiplayer browser integration
runs without a skip in both the default and server-execution ON pattern suites.
It exercises `PerSpace`, `PerUser`, and `PerSession` cells and SQLite databases
across two sessions for one identity, a second identity, and a guest reload.

## Protocol

Each loaded document owns a fresh capability session over a `MessagePort`.
Requests carry a protocol name, version, numeric request ID, operation, and
either a named resource or an opaque resolved-cell handle. Cell requests may
carry a path; push requests carry appended members separately from replacement
values. `resolve` returns a session-local handle plus stable identity metadata.
Responses correlate by ID and carry either a result or a structured error. Sinks
have explicit IDs and are cancelled when the guest cancels, reloads, or sends
the session-level `disconnect` operation.

The complete request, response, or event is encoded with `codec-realm`. This
preserves Fabric values such as `FabricBytes` instead of relying on structured
clone to preserve class instances.

Three browser realms participate: the host page, an outer frame that enforces
the CSP and loads documents, and the inner guest. The host transfers a port
directly to each guest; the outer frame does not relay capability traffic.

`reportGuestError(error)` is the exception. It posts a one-way alarm through the
parent so a guest can report failure before it has a working port. The host
emits a `common-iframe-error` event.

## Security considerations

- The bridge is capability-based, but every resource supplied to a frame is
  readable or mutable exactly as its descriptor says. Keep the manifest small.
- The remaining window `postMessage()` lifecycle, port handoff, and alarm
  traffic uses source-window checks but not origin-bound messages; audit that
  path before treating this as a hardened security boundary.
- Allowed script CDNs and their logging services can exfiltrate data.
- Links opened with `target="_blank"`, `document.baseURI`, and browser
  fingerprinting capabilities can reveal information outside the bridge.
- The iframe CSP, sandbox flags, and permissions policy are separate controls
  from Fabric's CFC checks. A bridge does not make an over-broad browser policy
  safe.

The double-frame construction exists because support for the iframe `csp`
attribute is inconsistent. The outer `srcdoc` frame applies a Content Security
Policy inherited by the inner guest document. See the [CSP processing model] and
[browser support for the `csp` attribute].

[CSP processing model]: https://www.w3.org/TR/CSP2/#processing-model-iframe-srcdoc
[browser support for the `csp` attribute]: https://caniuse.com/mdn-html_elements_iframe_csp
