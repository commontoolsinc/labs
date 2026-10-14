# Connector SQLite stores as first-class sources: what remains

**Status:** pending. Each item below needs the ruling it names before it is
built.

An injected on-disk SQLite source — a connector store another process writes,
linked into a pattern input with `cf piece link sqlite:<path>`
([`../specs/sqlite-builtin/03-database-sources.md`](../specs/sqlite-builtin/03-database-sources.md)
§03.3) — is read off the toolshed's event loop on read workers and cancelled
when its caller goes (spec 04, "Which thread runs a read"). Its registration
survives a restart, a read of one the server cannot read fails with
`SqliteSourceUnavailable` rather than returning `[]`, and a write to its handle
is refused before and after a restart (§03.3). What follows is the rest of
making such a store a source the runtime treats like one it owns.

## Why more

A pattern sees a connector store change only through a companion freshness
cell: the store's writer, or the process supervising it, writes a generation
into a cell in the pattern's space after each sync, and connector queries pass
that cell to `reactOn`
([`loom-resource-discovery.md`](loom-resource-discovery.md), "External
changes"). That works and costs nothing on a store that does not change, but
every connector pattern wires it, every embedding client maintains it, and a
pattern written for a cell-derived database — where `reactOn: db` is the whole
story — does not refresh when pointed at a connector store.

Some costs remain after the work above:

- A read whose connection drops settles as a failure under its request hash,
  so it stays failed until an input changes.
- Identical reads issued together each run, one scan apiece.
- A read holds its connection's turn for its space while a worker runs it, so
  that connection's later frames for the space wait for it.
- A read of a cell-derived database still runs on the main thread.

## What remains

### Native freshness

The server advances an injected source's version when its data changes, and
`reactOn: db` works for a connector store exactly as it does for a cell-derived
database (spec 05). The writer, or the process supervising it, sends a hint
after a sync — a verb such as `sqlite.disk-source-changed`, authorized as
registration is. The server reads `PRAGMA data_version` on a connection it keeps
for the source, which moves on another connection's commit and not on a
checkpoint, and increments the handle's `rev` with a patch at `/value/rev`
when it moved. A store rebuilt by renaming a new file over the old one leaves
that connection on the old file, so the check also compares the file's device
and inode with the connection's and reopens it when they differ. A hint
carries no generation, so a rebuilt store or a writer that crashes before
hinting leaves `rev` where the data says. The companion
freshness cell then has nothing left to do.

Rulings: the sqlite-builtin owner, on `rev` written by the server rather than
by `db.exec` (01, 05), and on the first check after a restart, which would
otherwise re-run every `reactOn: db` query on every source. The CFC spec owner,
on whether "this source changed at time T" is information a reader needs
clearance for, what label the increment carries, and who authors it.

### An unanswered read stays pending

A read that never completed — its connection dropped, it was cancelled, its
read worker failed — settles nothing, and keeps its `{ pending, requestHash }`
claim, which the memo decision already issues again when a runtime that is not
running it evaluates the query. A read that completed settles as today, error
included, under the serving loop's rule that failures commit an error-shaped
result "so retries are input-driven"
([`../specs/server-side-execution/serving-loop.md`](../specs/server-side-execution/serving-loop.md)
§4).

Ruling: the runtime's owners. The rule lives in the builtin's settle path, next
to the effect-completion bookkeeping every effect builtin shares, and is better
made once for `fetch*`, `generate*` and `sqlite*` than for SQLite alone.

### Identical reads share one run

The server keys an in-flight read by space, source, statement, parameters and
labeling, and hands every caller the rows. A caller joins only a read that has
not started: one that started may have begun before the commit a caller's
`reactOn` saw, and would settle older rows under the newer request hash. Each
caller cancels for itself; the read is interrupted when the last one goes.

Ruling: the sqlite-builtin owner, and the CFC spec owner on whether sharing a
read among callers in one space needs more than each caller's own
authorization check.

### A read releases its connection's turn once dispatched

A write to an injected source is refused, so a read of one has no
read-after-write order to keep once a worker has it. Releasing the
connection's turn for the space at dispatch would let that connection's later
frames — its commits among them — go ahead while the read runs.

Ruling: the memory protocol's owner (memory-v2 §4, the ordered frame queue).

### Cell-derived reads on the workers

A cell-derived database's file uses a rollback journal and the engine writes it
from the main thread, so its reads stay there: a worker holding the file's
shared lock would leave a commit waiting in SQLite's busy handler on the main
thread. In WAL mode a reader holds no lock a writer waits for, and the reads
can move to the workers.

Ruling: the sqlite-builtin owner, against the WAL caveat on cross-file atomicity
(spec 04, "Atomicity across cells and SQLite").

### Bounds

A worker read that never finishes holds its worker until its connection closes,
and the per-connection allowance is a heuristic (spec 04). A very large result
is converted to fabric values on the main thread. Each wants a bound that is
not a wall-clock timeout — a row or byte cap with a typed error, an allowance
per principal — and a measurement that shows it is needed (spec 08, Q8).

### A restart signal

`hello.ok` carries the serving process's boot id, so a client can tell a
reconnect from a restart. Durable registrations make it unnecessary for
injected sources; it is general, and presence or anything else a client keeps
in a server's memory can use it.

## Not proposed

- **A source id that survives re-pointing a source.** The resource-discovery
  plan keeps each handle's `(space, canonical path)` identity and never carries
  one handle's CFC context to another.
- **A "retryable" class of settled results.** The serving loop forbids
  re-firing an effect whose settled result has a matching key.
- **Writer-supplied generations, or file metadata, as a version.** A rebuilt
  store or a crashed writer would leave a generation wrong for good, and a WAL
  file keeps its size across checkpoints.
- **`rev` in a query's identity by default for injected handles only.** It would
  make the pattern API differ by source kind.
- **Writer-reported table statistics.** They are unverified writer data, and a
  count over labeled columns carries those columns' labels (06).
- **Timeouts, statement budgets, or a filesystem watch as a trigger.**
