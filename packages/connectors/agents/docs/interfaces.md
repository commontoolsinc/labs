# Agent connector interfaces and protocols

This document specifies the boundaries implemented by
`@commonfabric/agents-connector`. The TypeScript declarations remain the
authoritative source for exact types. This document explains their lifecycle,
formats, identity rules, and failure semantics.

## Package entry points

| Entry point                 | Purpose                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Package root                | Normalized types, collection, Fabric target, command worker, command ledger, stable graph helpers, cell identity helpers, and schema constants |
| `/create-driver`            | Provider selection without requiring the host to import each driver class                                                                      |
| `/drivers/claude-agent-sdk` | Claude Agent SDK driver and its testable SDK adapter interface                                                                                 |
| `/drivers/codex-app-server` | Codex App Server driver, launch selection, and execution policy                                                                                |
| `/drivers/acp`              | Agent Client Protocol driver and its testable transport interface                                                                              |
| `/fabric`                   | Fabric target and top-level cell creation                                                                                                      |
| `/fabric-graph`             | Lower-level stable graph reads, writes, action reads, and subscriptions                                                                        |
| `/commands`                 | Command and receipt values, target interface, and worker                                                                                       |
| `/command-ledger`           | Local command claim storage                                                                                                                    |
| `/reconcile`                | Provider collection and session preparation                                                                                                    |
| `/types`                    | Provider-neutral source, session, driver, and result types                                                                                     |

The package root intentionally excludes provider drivers. This keeps provider
SDK initialization and child-process setup out of programs that only consume the
normalized or Fabric APIs.

## Host orchestration API

### Source configuration

`AgentSourceConfig` describes one logical agent source.

| Field                   | Meaning                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                    | Stable source identity. Hosts should use a non-empty lowercase value. Commands normalize this value to lowercase. |
| `driver`                | `claude-agent-sdk`, `codex-app-server`, or `acp`                                                                  |
| `enabled`               | Host policy flag. `createAgentDriver()` does not filter disabled configurations.                                  |
| `command`               | Complete provider process command. Required by ACP. Overrides the derived Codex launch command.                   |
| `cwd`                   | Default working directory for provider processes and provider-owned prompts when supported                        |
| `env`                   | Environment entries added to provider operations or child processes                                               |
| `configDir`             | Claude configuration directory, exposed to the SDK as `CLAUDE_CONFIG_DIR`                                         |
| `codexBin`              | Codex executable used when `command` is absent                                                                    |
| `codexHome`             | Codex home directory, exposed to the child as `CODEX_HOME`                                                        |
| `codexTransport`        | `stdio`, `managed`, or `proxy`                                                                                    |
| `codexSocket`           | Optional socket passed to Codex proxy mode                                                                        |
| `allowDangerFullAccess` | Explicit permission for Claude bypass mode and unrestricted Codex turns                                           |

`createAgentDriver(config)` selects the class named by `config.driver`. It does
not start the driver. Each bundled driver trims and lowercases `config.id` when
it constructs its `SourceDescriptor`. Hosts use the descriptor ID, rather than
the unprocessed configuration value, as the key in driver maps. Hosts must
reject configurations whose IDs become equal after this normalization.

### Driver lifecycle

Every `AgentDriver` provides:

```ts
interface AgentDriver {
  readonly source: SourceDescriptor;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  listSessions(cursor?: string): Promise<SessionPage>;
  readSession(nativeSessionId: string): Promise<NativeSessionSnapshot>;
  prompt(
    nativeSessionId: string,
    input: PromptInput,
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  cancel(nativeSessionId: string): Promise<CommandExecutionResult>;
  renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult>;
  setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult>;
  setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult>;
}
```

The host calls `start()` once before inventory or commands. An abort signal can
cancel startup. The host calls `stop()` once during shutdown. `stop()` closes
connector-owned provider operations and child processes.

`source.capabilities` is mutable because ACP discovers some capabilities while
initializing or loading a session. A host should treat it as the current
provider contract rather than a constructor-time constant.

`CommandExecutionOptions.onCancellationReady` and `onSessionActive` report two
separate prompt milestones to the command worker. A driver calls
`onCancellationReady` as soon as its `cancel()` method can address the admitted
prompt. Claude reaches this point before session metadata lookup because its
pending-prompt record accepts cancellation. ACP and Codex reach it after their
provider prompt or turn has started.

A driver calls and awaits the asynchronous `onSessionActive` callback only after
the provider operation has started. This callback refreshes every command target
while the provider operation remains active. Drivers that can report active
provider state through `readSession()` keep that state observable until the
refresh finishes.

### Collection

`collectSource(driver, signal?)` consumes `listSessions()` until `nextCursor` is
absent. It records an inventory error for a repeated cursor. It also records an
error before retaining a page that would raise the inventory above 100,000
summaries. It then calls `readSession()` once for every retained summary. The
optional signal is checked before and after every provider call. A host still
stops the driver to interrupt a provider call that does not return on its own.

The returned `CollectedSource` contains successful snapshots and structured
errors. Its `complete` field is true only when enumeration completed, every
session read succeeded, and every snapshot reported itself complete.

`prepareSession(sourceId, snapshot, targetChunkBytes?)` is available when a host
or another target needs the connector's stable key, chunks, and hashes without
publishing to Fabric. It captures the summary, provider events, and normalized
messages as immutable `FabricValue`s before it measures chunks or computes
hashes. The returned chunks contain those captured event values.

### Fabric connection and target

`AgentFabricConnection` contains an initialized Common Fabric `Runtime` and one
`MemorySpace` DID:

```ts
interface AgentFabricConnection {
  runtime: Runtime;
  spaceDid: MemorySpace;
}
```

`AgentFabricTarget.open(connection)` creates and synchronizes the connector's
top-level cells. It also waits for the runtime storage manager to finish its
initial synchronization.

The target exposes these orchestration methods:

| Method                                    | Behavior                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `beginSessionObservation()`               | Allocates the ordering value that a caller records before it begins a full provider collection.         |
| `publish(collected, options?)`            | Publishes changed session graphs and replaces both indexes. Returns the number of non-deleted sessions. |
| `publishHealth(value)`                    | Publishes a host-defined health record under the connector-owned health schema.                         |
| `subscribeCommands(callback)`             | Subscribes to the command action array. Returns a Common Fabric cancellation function.                  |
| `pollCommands()`                          | Pulls the current command action array.                                                                 |
| `publishReceipt(receipt)`                 | Publishes one durable receipt cell and updates the bounded receipt index.                               |
| `readReceipt(commandId)`                  | Reads the deterministic individual receipt cell used as the shared command claim.                       |
| `refreshSession(driver, nativeSessionId)` | Reads and publishes one session without changing untouched session statuses.                            |
| `commandCellId()`                         | Returns the command cell ID without the `of:` link prefix.                                              |
| `receiptCellId()`                         | Returns the receipt-index cell ID without the `of:` link prefix.                                        |

The optional `publish()` setting `preserveUntouchedStatus` defaults to false.
Normal full collections should use the default. A targeted refresh should set it
to true.

A full collection calls `beginSessionObservation()` before its first provider
read and passes the returned value to `publish()` as `observationSequence`.
`refreshSession()` allocates its own value before its session read. When an
older full collection reaches the publication queue after a newer targeted
refresh, the target retains the newer session graph and index row. The same rule
prevents an older complete inventory from marking a newly refreshed session as
deleted. The target also records the newest complete observation for each source
so an older complete inventory cannot restore a session absent from a newer
inventory. Ordering values belong to one target instance and are not written to
Fabric.

`readReceipt()` validates the full receipt schema, normalized identities,
status, optional ISO timestamps and strings, error, and result before returning
a trusted receipt. `publishReceipt()` accepts only an absent receipt index or
the current receipt index object. A malformed existing index is an error and is
not replaced with an empty index.

### Command worker

The `CommandWorker` constructor receives a map keyed by normalized source ID,
one or more `CommandTarget` objects, one `CommandLedger`, and an optional
receipt callback followed by an optional command-task failure callback.

`handle(values)` validates and schedules a snapshot of command values. It
serializes overlapping calls to `handle()`, but it does not wait for all
provider operations. `drain()` waits for command parsing and every scheduled
operation. It throws an aggregate error after waiting if any scheduled operation
failed.

Before creating a local claim, the worker calls `readReceipt()` on targets that
provide it. A receipt already published for that command ID prevents another
provider call when a host moves to another local state directory, user, or
machine. The worker republishes a terminal receipt to repair its bounded index.
It changes a shared in-flight receipt without a terminal outcome to `unknown`.
Hosts still need external coordination to prevent two machines from checking and
claiming the same new command concurrently.

Commands other than cancellation run in admission order for each source and
native session. A cancellation admitted after a prompt waits until the driver
reports that its cancellation method can address that prompt. It then bypasses
the remaining session queue. If the prompt fails before reaching that milestone,
the cancellation starts after the prompt has produced its terminal outcome.

The optional receipt callback is an observer. It runs after the receipt is
durable in every target and the ledger publication marker is clear. A callback
failure is logged and does not turn a published command receipt back into
pending work.

The optional command-task failure callback receives command ID, source ID,
native session ID, and the thrown error as soon as scheduled work fails. It does
not receive the command payload.

`recoverUnpublishedReceipts()` changes ledger entries left in flight by a prior
process to unknown, then publishes every receipt whose publication was not
acknowledged. A host calls it before accepting new commands.

`parseCommandReceipt(commandId, value, context?)` is the shared validation
boundary used by Fabric reads and ledger reads. It returns a detached, validated
receipt or rejects the value. The optional context changes only the error
prefix.

## Normalized driver protocol

### Source descriptor and capabilities

`SourceDescriptor` contains the source ID, driver kind, optional provider
version, and `DriverCapabilities`.

The capability booleans describe inventory, reads, prompts, cancellation,
renaming, modes, and configuration options. `modes` lists accepted mode IDs.
`configOptions` carries provider-defined option descriptions.

Unsupported methods still exist on every driver. They return a
`CommandExecutionResult` with status `unsupported` and a structured error.

### Session inventory

`listSessions(cursor?)` returns a `SessionPage`:

```ts
interface SessionPage {
  sessions: SessionSummary[];
  nextCursor?: string;
}
```

`SessionSummary.nativeSessionId` is the provider's durable session identity. The
other normalized fields are nullable because providers expose different
metadata. `archived` reports whether the provider has archived the conversation.
`active` reports whether the provider considers the conversation active. A null
value means that the provider did not report that part of the lifecycle state.
`raw` retains the provider summary as a plain object.

Inventory can expose lifecycle state that a full session read omits.
`collectSource()` retains the inventory value for `archived` or `active` when
the corresponding snapshot value is null. A non-null snapshot value takes
precedence.

The connector enriches `gitRepo`, `gitBranch`, and `gitWorktreeRoot` after the
driver returns the snapshot.

### Session snapshot

`readSession()` returns a `NativeSessionSnapshot` with four views:

- `summary` is normalized inventory metadata.
- `events` is the provider-native history in its original order.
- `normalizedMessages` is a compact provider-neutral message view.
- `complete` states whether the history is safe to treat as a complete snapshot.

`revision` is an optional provider token used as data and included in the
snapshot hash. The connector does not use it for conditional provider reads.

Each normalized message has an ID, optional parent ID, normalized role, native
kind, nullable timestamp, text preview, and native event index. Text previews
are limited to 500 characters by the bundled drivers.

### Command result

Every provider operation returns `CommandExecutionResult`. Its status is one of
`succeeded`, `failed`, `unsupported`, `needs-confirmation`, or `unknown`.

`providerOperationId` records a provider turn or operation identity when one
exists. `result` contains provider-specific success details. `error` contains a
stable code, human-readable message, and a retryability statement. The command
worker copies these fields into the terminal receipt.

`unknown` means the connector cannot prove whether the provider operation
completed. Callers must not treat it as safe to repeat automatically.

## Native provider boundaries

### Claude Agent SDK

The Claude driver calls these SDK operations through `ClaudeSdkAdapter`:

- `listSessions({ limit, offset })`
- `getSessionInfo(sessionId)`
- `getSessionMessages(sessionId, { includeSystemMessages: true })`
- `renameSession(sessionId, title)`
- `query({ prompt, options })`

Inventory pages contain 100 sessions. The cursor is a decimal offset. Message
objects become native events. Their UUID, type, and message content provide the
normalized message view.

The driver reports `active: true` while a prompt started by that connector
process is running. It snapshots that state when an inventory or session read
starts. It also awaits the command worker's active-session callback before it
consumes provider output. These rules keep short prompts observable during the
publication read. The driver cannot infer `active: false`, because another
process may be using the same conversation. TODO(@ianh): Populate normalized
`archived` and provider-wide `active` values after the Claude SDK exposes
lifecycle metadata for listed sessions. The current session information contains
titles, timestamps, branches, and working directories, but no archive or
activity state.

The SDK owns its on-disk session format. The connector does not parse Claude
session files directly.

Short inventory and metadata calls receive source-specific environment values
through a process-wide serialized environment change. Prompts receive an
explicit environment object. This permits prompts for different Claude sources
to run concurrently without sharing temporary configuration values.

Prompts use the SDK `query()` async generator with `resume` set to the native
session ID. Claude locates resumable sessions within a working directory. The
driver therefore passes the directory recorded by `listSessions()` or
`getSessionInfo()`. It uses the source configuration's `cwd` only when the
session metadata has no directory. An uncached prompt reads the session
information before starting the query. A missing session or failed metadata
lookup produces a failed command result without starting Claude.

Cancellation during that metadata lookup marks the pending prompt and prevents
the query from starting. Stopping the driver does the same for every pending
prompt. A prompt submitted after the driver stops fails without calling the SDK.

The final SDK result determines the command status. Cancellation calls
`interrupt()` only for a query started by this connector instance.

Mode and model settings are kept in process memory per session. They apply to
connector-owned prompts. `bypassPermissions` is advertised only when
`allowDangerFullAccess` is true.

### Codex App Server

The Codex transport uses JSON-RPC 2.0 objects separated by newlines on child
process stdin and stdout. Request IDs are increasing integers. Notifications
have a method and no ID. Server requests have both a method and an ID.

The launch modes are:

| Mode      | Command behavior                                                           |
| --------- | -------------------------------------------------------------------------- |
| `stdio`   | Starts `codex app-server --listen stdio://`                                |
| `managed` | Runs `codex app-server daemon start`, then starts `codex app-server proxy` |
| `proxy`   | Starts `codex app-server proxy` and optionally passes `--sock`             |

An explicit `command` replaces the derived command. `CODEX_HOME` is set from
`codexHome`. Child stderr is drained without copying transcript data to the host
output.

Startup sends `initialize` followed by the `initialized` notification. Inventory
calls `thread/list` for active threads first and archived threads second. Its
internal cursor format is `active:<provider cursor>`, `archived:`, or
`archived:<provider cursor>`. Session reads call `thread/read` with
`includeTurns: true`. The inventory query supplies the normalized `archived`
value when an individual thread object omits it. A thread status with type
`active` maps to `active: true`. The `idle`, `notLoaded`, and `systemError`
statuses map to `active: false`.

Prompts call `thread/resume` and then `turn/start`. The driver waits for the
matching `turn/completed` notification. Cancellation calls `turn/interrupt` only
for a turn started by this connector instance. Rename calls `thread/name/set`.

The transport retains up to 500 notifications so a completion that arrives
before its waiter is registered can still satisfy that waiter. Process exit
rejects all pending requests and notification waits.

Codex command-execution and file-change approval requests are declined because
the connector has no interactive permission surface. When
`allowDangerFullAccess` is true, connector-owned turns set approval policy to
`never` and sandbox policy to `dangerFullAccess`.

### Agent Client Protocol

The ACP transport starts the configured command and uses the ACP SDK's
newline-delimited JSON stream over child stdin and stdout. It initializes with
the current SDK protocol version and identifies itself as
`commonfabric-agents-connector`.

The agent must advertise both `session/list` and `session/load`. Startup fails
when either operation is absent. Inventory cursors and summaries pass through
the ACP SDK types.

Session reads call `loadSession`. Session update notifications received during
that call become native events. Their `sessionUpdate` kind, content, and ID
provide the normalized message view. Loads for one native session are serialized
because ACP notifications identify only the session, not the load request that
produced them. This includes the fallback `loadSession` call that prepares a
prompt when resume is unavailable. Loads for different sessions can overlap.

Prompts call `resumeSession` when the agent advertises resume support. Otherwise
they call `loadSession` before `prompt`. Cancellation is available only while a
connector-owned prompt is active.

Session modes and configuration option descriptors are learned from successful
`loadSession` and `resumeSession` responses. A later response replaces the
controls for that session, including removing controls that are absent. A
successful `setSessionConfigOption` response replaces that session's option
descriptors. The published source capabilities contain the sorted union of mode
IDs and an object of option descriptors keyed by option ID. Completed inventory
removes control metadata for sessions that are no longer present.

Mode and configuration commands are checked against the controls for their
target session. Boolean options accept booleans. Select options accept only an
advertised string value, including values nested in option groups. ACP has no
portable rename operation.

ACP permission requests return a cancelled outcome. The connector passes an
empty MCP server list. Child stderr is copied to the connector's error output
with an ACP prefix.

## Fabric protocol

### Top-level cell causes

All top-level causes include the destination `spaceDid`. The remaining fields
are fixed:

| Cell                   | Cause fields                                           |
| ---------------------- | ------------------------------------------------------ |
| Recent session index   | `agentConnector: "recent-session-index"`, `version: 1` |
| Complete session index | `agentConnector: "all-session-index"`, `version: 1`    |
| Health                 | `agentConnector: "health"`, `version: 1`               |
| Commands               | `agentConnector: "commands"`, `version: 1`             |
| Receipt index          | `agentConnector: "receipts"`, `version: 1`             |

Session, chunk, and individual receipt causes add their durable identities:

```json
{
  "spaceDid": "did:key:...",
  "agentConnector": "session",
  "version": 1,
  "sourceId": "codex",
  "nativeSessionId": "session-id"
}
```

Chunk causes use `agentConnector: "session-chunk"` and add `part` and
`contentHash`. Receipt causes use `agentConnector: "command-receipt"` and add
`commandId`.

### Schema names

`AGENT_CONNECTOR_SCHEMAS` exports every format discriminator:

| Value              | Schema                                             |
| ------------------ | -------------------------------------------------- |
| Session manifest   | `commonfabric.agent-connector.session.v1`          |
| Event chunk        | `commonfabric.agent-connector.session-chunk.v1`    |
| Session index      | `commonfabric.agent-connector.session-index.v1`    |
| Health             | `commonfabric.agent-connector.health.v1`           |
| Command            | `commonfabric.agent-connector.command.v1`          |
| Individual receipt | `commonfabric.agent-connector.command-receipt.v1`  |
| Receipt index      | `commonfabric.agent-connector.command-receipts.v1` |
| Local ledger       | `commonfabric.agent-connector.command-ledger.v2`   |

The connector recognizes only these current values. It does not read earlier
names or publish compatibility aliases.

### Session key

`sessionKey(sourceId, nativeSessionId)` trims both values, lowercases the source
ID, rejects ASCII control characters, percent-encodes each identity, and joins
them with one slash. The native session ID remains case-sensitive.

For example, source `Codex:Work` and session `abc/123` produce
`codex%3Awork/abc%2F123`.

### Event chunks

The default target is 512 KiB of JSON per chunk. Each provider event is
serialized once for byte measurement. Array brackets and separators are counted
exactly. Provider events remain whole. One event larger than the target occupies
one oversized chunk. An empty snapshot produces part zero containing an empty
event array. Byte lengths describe the captured events that publication writes.

A chunk value has this form:

```json
{
  "schema": "commonfabric.agent-connector.session-chunk.v1",
  "formatVersion": 1,
  "key": "codex/session-id",
  "part": 0,
  "contentHash": "sha256:...",
  "events": []
}
```

The manifest stores a descriptor for each chunk. A descriptor contains the part,
live Fabric cell link, content hash, encoded byte length, and event count.

The chunk root cause includes its content hash. The scope for every array child
inside the chunk includes the part and content hash. Once a chunk graph has been
written, a later snapshot with different content writes different cells.
Publication writes these immutable chunk graphs before it replaces the session
manifest. An interrupted publication can leave unreferenced new chunks, but it
does not change the chunk graph reachable from the retained manifest.

### Session manifest

A session manifest contains:

- `formatVersion: 1`
- `key`, `sourceId`, `driver`, and `nativeSessionId`
- `metadata`, which repeats the provider-native summary object
- `summary`, which contains normalized summary fields
- `normalized.messages`, which contains the complete normalized message list
- `chunks`, which contains chunk descriptors rather than inline native events
- `snapshotHash`, optional provider `revision`, observation time, and
  completeness

`driver` records the provider boundary that produced this snapshot. The target
rewrites the manifest when a source ID is reconfigured to use another driver,
even when the provider content hash is unchanged.

The manifest is authoritative for the provider that produced its snapshot. The
index row repeats `driver` for listing, but it can lag the manifest when a
publication stops between the manifest and index writes.

The manifest uses a deterministic cause, so rewriting the same session updates
the same manifest cell. A chunk whose content changes uses a new root and new
array-child cells.

### Session indexes

Both indexes use the session-index schema. `bucket` distinguishes `recent` from
`all`. The recent index contains non-deleted sessions updated within the last
seven days. The complete index contains every non-deleted session and retained
deleted entries. Archived and provider-inactive sessions remain published until
the connector marks their synchronization status as `deleted`.

Each index records generation time, monotonically increasing generation,
non-deleted session count, older session count, source status rows, and session
entries. A session entry includes `formatVersion: 1`, the producing `driver`,
normalized metadata, nullable `archived` and `active` lifecycle fields, provider
capabilities, up to 12 recent normalized message previews, a live manifest cell
link, content hash, and synchronization status. The lifecycle fields describe
provider state. Synchronization status describes the connector's published copy.

The manifest and chunk fields are stored as `FabricLink`s rather than copied
objects. A consumer whose schema declares those fields as `Cell` values can read
one session graph without hydrating every session represented by the index. The
target rejects an index containing an entry without `formatVersion: 1`. It does
not convert older entries or manifest link representations.

TODO(@ianh): Add a shallow session directory containing each row link and its
sortable title, update-time, and worktree keys. The current stable-cell layout
lets a consumer page without loading every row, but global sorting requires
reading every linked row cell.

Synchronization status is `complete`, `partial`, `stale`, or `deleted`. Deleted
entries retain `deletedAt`.

### Stable array cells

Every array element inside a published graph is represented by a child cell. The
child cause is independent of the element's array position:

```json
{
  "agentConnector": "array-element",
  "version": 1,
  "scope": {
    "spaceDid": "did:key:...",
    "agentConnector": "session-index-array-elements",
    "version": 1
  },
  "path": ["sessions"],
  "identity": { "field": "key", "value": "codex/session-id" }
}
```

The publisher assigns one base scope to each stored value:

| Stored value                | Base `agentConnector` scope            | Additional scope identity                            |
| --------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Session event chunk         | `session-events-array-elements`        | `sourceId`, `nativeSessionId`, `part`, `contentHash` |
| Session manifest            | `session-array-elements`               | `sourceId`, `nativeSessionId`                        |
| Recent and complete indexes | `session-index-array-elements`         | None                                                 |
| Health                      | `health-array-elements`                | None                                                 |
| Individual command receipt  | `command-receipt-array-elements`       | `commandId`                                          |
| Receipt index               | `command-receipt-index-array-elements` | None                                                 |

Every base scope also contains the destination `spaceDid` and `version: 1`.
These fields and the additional identity participate in the child cell ID.

A schema-aware Fabric consumer must declare every array item as
`Cell<T> | undefined`, not as inline `T`. The `undefined` branch represents a
linked child that has not loaded yet. This applies to the index `sources` and
`sessions`, health `sources` and `activity`, receipt-index `receipts`, session
`chunks` and normalized messages, chunk `events`, and arrays nested inside
provider JSON. The pattern runtime presents a loaded item as its live `T` value
while retaining the cell back-pointer, so pattern code reads the item's fields
directly and can forward the value to an input declared as `Cell<T>`. Connector
code outside a pattern can use `readStableCellGraphValue()` when it needs a
detached, fully hydrated value instead.

Nested arrays use their containing array element's complete cause as `scope`.
Their `path` restarts inside that element. For example, the `recentMessages`
array in a session index row is scoped by the cause of that session row and uses
`path: ["recentMessages"]`. This recursive rule prevents equal nested IDs in two
different sessions from resolving to the same child cell.

Identity fields are considered in this order: `key`, `id`, `uuid`, `commandId`,
`messageId`, `toolCallId`, and `toolUseId`. A pair of `sourceId` and
`nativeSessionId` is next. Secondary fields are `nativeSessionId`, `sessionId`,
`part`, and `contentHash`. Values without one of those identities use a
canonical content hash. The planner analyzes the captured value tree once. Each
array or object node hashes its immediate child hashes, so nested provider data
does not require repeated planning.

Colliding identities add `collisionHash`. Exact duplicate values add a
zero-based `duplicate` number after the first occurrence.

### Canonical hashes

Connector hashes use SHA-256 and the `sha256:` prefix. The hash input describes
the graph produced by the stable-array planner. It includes the converted root
value and every deterministic child cell's cause and converted value. Each root
or child value gets its own cell-to-link and native-to-Fabric conversion. These
are the same conversion boundaries used when the graph is written.

`stableFabricValue()` performs this conversion for both hashing and graph
writes. It replaces connector-owned cells with complete `FabricLink`s. It then
captures native plain data as immutable `FabricValue`s. Native `toJSON()`
methods and property getters run during this capture. Later hashing and writing
use the captured result, so a mutable native object cannot change between those
steps. Shared JavaScript references retain their `FabricValue` semantics and do
not become path-only links. Circular values and arrays with enumerable named
properties are rejected at this boundary because they have no supported Fabric
representation. Supported Fabric protocol instances are captured as private
immutable values. Links and errors are rebuilt around captured state. Unknown
and problematic tagged values receive the same treatment because their general
deep-clone methods are not yet implemented. This includes links returned by
connector-owned cells in the modern cell representation. Mutating an original
instance, nested state, link, or link payload cannot change a planned hash or
graph. Captured `FabricLink`s are atomic planner values. Arrays inside a link
payload, including a cell subpath, are not split into child cells.

The `FabricValue` hash distinguishes undefined values, sparse array holes,
special numbers, bigints, bytes, dates, regular expressions, errors, and other
accepted `FabricValue`s. Object key order does not affect the hash. Array order
is preserved.

### Graph commits and hydration

`pushStableCellGraph()` accepts `StableCellGraphEntry` values. Each entry names
one root cell and provides a synchronous `value(materializeCell)` callback. The
callback builds the root object. It calls `materializeCell(cause, value)` for
each deterministic child and places the returned cell in that object.

The materializer writes each child through the graph's runtime edit transaction
and returns the child cell. The parent conversion replaces that cell with its
`FabricLink`. Nested children are written before the child that links to them.

Existing object values use the same field-write approach as Loom's stable graph
helper. Each property is written at its own path under the cell's `value` field.
Keys present in the transaction's prior value but absent from the new value are
deleted. This preserves other fields in the stored cell document. New objects,
values replacing a different value type, and non-object child values are written
as complete cell values. Root values are plain objects.

`AgentFabricTarget` serializes its mutations within one process. Observation
ordering also prevents a provider snapshot read earlier from overwriting a
session refresh that finished sooner. The repository's command-line host takes a
target process lock. Hosts on different machines need equivalent single-instance
coordination for each API and space pair.

`pushStableCellGraph()` reports transaction commit errors and does not retry.
The callback must finish synchronously and return a plain record. Causes and
values must be accepted by the Common Fabric cell and value converters.

Session graph publication batches at most ten content-addressed chunk cells per
transaction and one manifest per transaction. Index cells are committed after
session graphs. Because changed chunks use new root and child cells, committing
chunks before a manifest cannot mutate the graph reachable from the prior
manifest.

`readStableCellGraphValue()` synchronizes a root cell and recursively hydrates
`FabricLink`s. It caches repeated links within one read and synchronizes at most
50 array children concurrently.

Its optional fourth argument accepts `preserveLinkFields`. A link stored under a
named object field in that set remains a link instead of being hydrated. The
Fabric target preserves `manifest` while it merges prior session indexes, so a
normal publication does not read every transcript. The cache key includes the
preserved-field set, so callers can safely reuse a cache across different read
policies.

`subscribeStableActions()` treats a non-array cell value as an empty action
list. `readStableActions()` has the same convention for polling.

## Command and receipt formats

### Command

The command cell is an array of command objects. `CommandWorker` also accepts a
JSON string containing one command object.

```ts
interface AgentSessionCommand {
  schema: "commonfabric.agent-connector.command.v1";
  id: string;
  createdAt: string;
  sourceId: string;
  nativeSessionId: string;
  type: "prompt" | "cancel" | "rename" | "set-mode" | "set-config-option";
  payload: Record<string, unknown>;
  force?: boolean;
  requestedBy?: string;
}
```

Command IDs are limited to 256 characters. Source IDs are limited to 256. Native
session IDs are limited to 1,024. The worker requires non-empty strings but does
not interpret `createdAt` as a date.

Payloads are:

| Type                | Payload                                                     |
| ------------------- | ----------------------------------------------------------- |
| `prompt`            | `text` string, at most 128 KiB                              |
| `cancel`            | Empty object                                                |
| `rename`            | `title` string, at most 512 characters                      |
| `set-mode`          | `mode` string, at most 128 characters                       |
| `set-config-option` | `key` string, at most 256 characters, and arbitrary `value` |

`force` is passed only to `prompt()`. Bundled drivers currently do not change
their behavior based on it. `requestedBy` is retained on the parsed command but
is not copied to receipts.

Invalid values are logged and skipped. A command ID already present in the
ledger or already scheduled in the process is skipped.

### Receipt

An `AgentSessionCommandReceipt` records command identity, session identity,
status, claim and completion times, optional provider operation ID, optional
error, and optional provider result.

Command, source, and native session identities must already be in their
canonical form. Claim and completion times, when present, use the exact UTC ISO
format produced by `Date.toISOString()`. Status is one of `pending`,
`in-flight`, `succeeded`, `failed`, `unsupported`, `needs-confirmation`, or
`unknown`. An optional error contains non-empty `code` and `message` strings and
a Boolean `retryable` value. An optional result is an object.

The worker writes an `in-flight` receipt before the provider call. It then
writes one terminal receipt. A failed in-flight receipt publication prevents the
provider call and produces a failed receipt with code `claim-publish-failed`.
For a prompt, the worker passes a session-refresh callback to the driver. A
driver can call it after the session can safely report connector-owned activity.
The driver awaits that callback while the activity remains observable. The
worker refreshes the session again after every terminal outcome, which clears
the connector-owned activity after success or failure. Each ledger write marks
that receipt as awaiting publication. The worker removes that marker only after
every target accepts the value. It then invokes the optional receipt callback as
an observer. Startup republishes markers left by a failed publication or process
exit.

Each command has a deterministic individual receipt cell. The top-level receipt
index stores summary rows and links to those cells. It retains the 200 most
recently appended command IDs. Republishing one command replaces its existing
summary row before appending the new state.

The receipt index contains the current receipt-index schema, an ISO `updatedAt`
timestamp, and a `receipts` array. Each summary row repeats the canonical
command, source, and native session identities, receipt status, ISO update time,
and optional structured error. Its `receipt` field is the complete `id`,
`space`, and `path` link for that command's deterministic receipt cell.
Duplicate command IDs and malformed current-schema indexes are errors. The index
may contain at most 200 rows. Publication does not carry invalid rows into a
rewritten index.

## Local command ledger

`CommandLedger.open(path)` reads a UTF-8 JSON file with this shape:

```json
{
  "schema": "commonfabric.agent-connector.command-ledger.v2",
  "generation": 12,
  "receipts": {
    "command-id": {
      "schema": "commonfabric.agent-connector.command-receipt.v1",
      "commandId": "command-id",
      "sourceId": "codex",
      "nativeSessionId": "session-id",
      "status": "succeeded"
    }
  },
  "pendingPublicationCommandIds": []
}
```

A missing file opens as an empty ledger. A present file must contain valid JSON
with the current schema, a non-negative safe-integer `generation`, a `receipts`
object, and a `pendingPublicationCommandIds` string array. Invalid or older
formats are rejected. Receipt map keys must equal their receipt `commandId`
values. Every receipt schema, identity, status, optional error, and optional
result is validated. Pending command IDs must be unique and must refer to stored
receipts.

The optional receipt `result` is stored as an `fvj1:` Fabric JSON string inside
the outer ledger JSON file. The ledger decodes that string before returning a
receipt. This preserves `undefined`, big integers, special numbers, links, and
other `FabricValue`s across process restarts.

Writes are serialized. Receipts are sorted by command ID. Every committed write
increments `generation`. On Unix systems, the ledger writes an indented
temporary file in the same directory and atomically renames it over the
configured path. It synchronizes the temporary file before the rename and the
parent directory afterward.

Windows alternates generations between the configured path and a `.previous`
file. It writes and synchronizes the inactive slot before making it current in
memory, so it never truncates the newest valid generation. Startup validates
both slots and selects the valid value with the highest generation. An invalid
slot left by an interrupted write is ignored when the other slot is valid. Two
valid slots with the same generation must contain the same state. The initial
empty generation is committed before `open()` returns. When only one valid slot
exists, `open()` repairs the inactive slot before returning. Every later
mutation therefore overwrites an existing inactive file while retaining the
newest valid file.

The ledger creates its directory with mode `0700` and its files with mode
`0600`. On systems with Unix permissions, it rejects the final directory or
either ledger slot when it is a symbolic link, belongs to another user, or
permits group or other-user access.

`pendingPublicationCount()` reports the current outbox size. It does not expose
receipt contents. A host uses this value when deciding whether health can return
to ready.

`put()` stores a receipt and marks it pending. `markPublished()` clears that
marker. `get()` and recovery results return clones. Callers cannot mutate the
ledger's in-memory values without calling `put()`.

## Git metadata boundary

`GitContextResolver` uses the session working directory as input. It runs:

1. `git -C <cwd> rev-parse --show-toplevel`
2. `git -C <root> branch --show-current`
3. `git -C <root> remote get-url upstream`
4. `git -C <root> remote get-url origin` when upstream is absent

`beginObservation()` creates a lookup scope for one publication. It deduplicates
equal working directories and equal repository roots within that scope. A new
publication creates a new scope and reruns the commands, so branch and remote
changes appear in later publications. Failed lookups are also scoped to one
observation, which allows a directory that becomes a repository later to acquire
metadata. Direct `resolve()` and `enrich()` calls each create a fresh
observation.

A missing working directory, a non-repository directory, or a failed Git process
produces null metadata rather than a failed session publication.

The connector stores the remote string exactly as Git returns it. It does not
canonicalize SSH and HTTPS URLs or inspect repository contents.
