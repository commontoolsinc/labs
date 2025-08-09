# Unifying the storage stack

## Current state

Right now we have a few overlapping and uncoordinated layers of storage related
functionality that needs reconciling. Most importantly we see data loss since
the transaction boundaries don't line up, but it's also a lot of code that can
be simplified away.

Specifically we have:

- I/O over iframe boundaries, typically with the iframes running React, which in

Note: We will keep SQLite code under packages/storage/src/sqlite (do not split into packages/sqlite). Add a follow-up cleanup task to consolidate any stray directories if they appear.
  turn assumes synchronous state. So data can roundtrip through iframe/React and
  overwrite newer data that came in in the meantime based on outdated
  assumptions. E.g. a user event happens, state X is updated in React, while new
  data is waiting in the iframe's message queue: Now an update based on older
  data is sent to the container, but since there is no versioning at this layer,
  it is treated as updating the current data. Meanwhile the iframe processes the
  queued up update, and now is out of sync with the container. Note that this is
  a pretty tight race condition: Some event processing coincides exactly with
  receiving data updates. It's rare, but we've seen this happen when tabs get
  woken up again and a lot of pent up work happens all at once.
- Scheduler executing event handlers and reactive functions, which would form a
  natural transaction boundary -- especially for event handlers to re-run on
  newer data to rebase changes -- but those boundaries don't mean anything to
  the rest of the stack. The only thing is that we make sure data isn't changed
  while a handler/lifted function is running (await idle in storage.ts).
- DocImpl that represent the data exposed to user code, typically via Cell.
  Changes to it are directly applied to the data, and listeners are notified.
  The only two listeners are the scheduler, which uses this to mark data dirty
  and schedule the respective reactive functions and storage.ts, which adds
  those documents to the next batch to be processed.
- storage.ts which connects the lower storage layer with DocImpl. It wants to
  make sure that the upper layers see a consistent view, so when a new document
  contains a link to another document, it'll fetch that before updating the doc,
  recursively. It also fetches all source docs (i.e. `doc.sourceCell`), also
  recursively.
  - This also means that changes from the upper layer can accumulate while all
    this loading happens, and then altogether become one transaction: And if
    there is one conflict anywhere, the entire transaction is rejected. And
    while the actual conflict source gets eventually updated (since the server
    will send these, and document that is read is also being subscribed to) the
    other documents that were locally changed are not reverted. The clients get
    out of sync.
  - Also, if new data arrives from the server that overwrites local data that
    was just changed, that is effectively a silently handled conflict, with the
    same issues as above!
  - Progress: We now also have schema queries, which will immediately fetch all
    documents that are needed per a given schema, and will keep those up to
    date, even if links change (meaning the subscription adds newly needed
    documents and no longer subscribes to no longer used documents). That could
    already replace a lot of the logic above, but we haven't turned that off. It
    also currently doesn't use the cache.
- storage/cache.ts, the memory layer, which operates at the unit of documents,
  supports CAS semantics for transactions. It's used by storage.ts only and
  while it has stronger guarantees, those either don't apply or sometimes
  backfire because they are not aligned with the top: The upper layers don't
  have a concept of "cause" and depending on the order of operations we
  currently issue updated with the latest cause, but actually based on older
  data. It has a cache but we underuse it. Key implementation details:
  - Heap (partial replica of the remote state) and nursery (pending changes)
    separation
  - WebSocket sync with `merge()` for server updates
  - Schema query support exists but incomplete (see pull() at line 1082)

## Desired state

- Iframe transport layer sends incrementing versions and ignores changes that
  are based on too old changes. It's then up to the inside of the iframe to use
  that correctly. In fact `useDoc()` where `setX()` takes a callback (e.g.
  `setX(x => x + 1)`) instead of just the new value would already work much
  better, since we can rerun it on the newest state if new state arrives that
  invalidates previously sent updates. Probably sufficiently well for most cases
  (the remaining problem would be that if other changes based on `X` changing
  aren't purely reactive, i.e. only based on the last state, that those are not
  being undone by rerunning the setter. This is rare, even in React). But we
  could go even further (maybe some popular game toolkits are worth
  investigating here at some point in the future, since that's a good usecase
  for iframes)
- Cells –- constructed typically by the runner when bringing up a recipe, within
  handlers or reactive functions and in some cases by parts of the shell to
  bootstrap things -- directly read from memory via schema query. They
  accumulate writes and wait for the scheduler to close out a transaction.
  Interim reads see the new version.
- Scheduler runs handlers and reactive functions and then issues a transaction
  with pending writes directly to the underlying memory layer (we already log
  reads and writes via `ReactivityLog`, so we can extend that to log the exact
  writes, not just which documents were affected). It registers with the
  underlying memory layer (instead of with `DocImpl` as before) for changes on
  individual documents, marking –– as is already the case –– the corresponding
  reactive functions as needing to run (semantically we want to subscribe to the
  corresponding schema queries, but at least with the current queries, listening
  to the actually read docs is the same). For events it will keep track of the
  transaction and if it fails, and after we're sure to have caught up enough
  with the server to reflect the new current state, retry up to N times.
- Memory -- more or less like now, except that its lower level API is directly
  exposed to cells, including `the` and the document ids as DIDs (so the Cell
  will have to translate the ids an prepend `of:`)

## Steps to get there

This plan should be entirely incremental and can be rolled out step by step.

- [x] Ephemeral storage provider + Get rid of `VolatileStorageProvider` CT-420
- [x] Schema queries for everything + Source support CT-174 CT-428
  - See design note on cache, but that's not blocking progress on the rest
- [x] Turn off "crawler" mode in storage.ts, make sure things still work
  - The crawler is in `storage.ts:_processCurrentBatch()` (lines 478-577) which
    recursively loads dependencies
  - Key areas: loading promises map (line 84), dependency tracking, and batch
    processing
  - Watch for the FIXME at line 84 about keying by doc+schema combination
- [x] When connection is dropped, re-establish all schema queries again CT-442
- [ ] Replace all direct use of `DocImpl` with `Cell` (only `DocImpl` use inside
      `Cell`, scheduler (just `.updates()`) and storage.ts should remain for
      now) CT-446
  - [x] Add .setRaw and .getRaw to internal `Cell` interface and use the cell
        creation methods on `Runtime` and then almost all used of `DocImpl` can
        be replaced by cells and using `.[set|get]Raw` instead of
        `.[set|send|get]`
- [ ] Change all places that expect `{ cell: DocImpl, … }` to just use the JSON
      representation. At the same time, let's support the new syntax for links
      (@irakli has these in a RFC (CT-448), should be extracted, effectively
      `{ "@": { "link": { ... }}}`). This is because today `storage.ts`
      translates any `{ "/": string }` it finds to `{ "/": DocImpl }`, but we
      don't want to carry this logic over to this new state. See `isCellLink`,
      which might not be universally used, but should be. Maybe add a
      `readCellLink` function to parse these. CT-447
  - [x] Also change schema queries on the serverside
  - [x] Remove that translation in storage.ts and make sure everything still
        works.
- [x] Create a new transaction API: Get a `tx` object from memory, which exposes
      `tx.read(entity, path)`, `tx.write(entity, path, value)` (and/or other
      mutation functions), etc., and `tx.commit()`, `tx.abort(reason?: Error)`
      and a few more (see below). CT-449
- [ ] Implement a shim of the new TX API using `DocImpl`, etc. CT-485
  - [ ] Wherever `log` get created, switch to new API. So at least
    - [ ] scheduler
    - [ ] Cell.sink
  - Need to call .commit() when done (TBD: Even on read-only?)
  - Change read/write
    - [ ] `diffAndNormalize` and `applyChangeSet`
    - [ ] remaining `Cell.*` (e.g. `getRaw`, `setRaw`)
    - [ ] `QueryResultProxy`
  - [ ] Move ephemeral and frozen concept into Cell
    - [ ] `Cell.freeze()` makes cell read-only
    - [ ] `Cell.ephemeral` whether cell is persisted
- [ ] Switch all reading & writing over to this new TX API CT-486
- [ ] Add a `VirtualCell` that is used in runner to construct inputs, which is
      read-only, has no id or space and isn't synced to storage. It should throw
      if used in any way that indicates it is being linked to or written to.
      CT-493
- [ ] Add `Cell.sync` call that does what `Storage.syncCell` does today. CT-494
  - [ ] In fact automatically start syncing already, as this will be the future
        behavior. This is just for await.
  - [ ] Add option to only await a locally cached version if available.
- [ ] Add path-dependent listeners to memory: A helper on `Storage`, that given
      a `TX` calls a callback _once_ on future changes on what was read during
      the transaction (observing only changes affecting the read path). Make it
      cancelable (the scheduler will e.g. cancel this before executing the
      action again). First design the API.
- [ ] Shim the API above and switch scheduler to use it
  - [ ] The current reads and writes from a TX can be read out, which scheduler
        will use to update the dependency graph. In fact scheduler will inside
        the callback do both this and adding the callback just before returning.
        It does so to not miss any updates.
- [ ] Implement new TX over memory CT-487
  - [ ] The user of the TX shall observe a consistent state during the lifetime
        of the transaction. All its writes are only committed to the nursery
        after `tx.commit()` is called. If the transaction attempts to read a
        value that has changed since the start of the transaction, the
        transaction is aborted.
- [ ] Shift `Cell.sync()` to make schema queries on memory directly.
- [ ] Implement new listener API.
  - [ ] Path-dependent means that we diff updates and compute what paths have
        changed. Callback gets called if any paths overlap, i.e. one is a subset
        of the other. See `compactifyPath` and `pathAffected` for current
        implementation.
- [ ] Scheduler retries events whose transaction failed. It does so up to N
      times and calls a callback after the last retry (both configurable via
      `Runtime` constructor). Events are retried after all read cells are fully
      synced and reactive functions that are queued up are settled, so it's
      guaranteed to be a stable state (Future optimization: Dynamically insert
      into the queue after any reactive function that might update the handlers
      inputs, but before any that read its outputs)
  - [ ] For change sets that only write (e.g. only push or set), we could just
        reapply those without re-runnin the handler. But this could also be a
        future optimization.
- [ ] More selectively purge the nursery on conflicts by observing conflicted
      reads. CT-451
- [ ] On conflicts add data that changed unless it was already sent to the
      client by a query. CT-452
- [ ] Remove `storage.ts` and `DocImpl`, they are now skipped CT-453
- [x] Memory layer with pending changes after a conflicted write: rollback to
      heap and notify that as changes where it changed things
- [ ] Sanitize React at least a bit by implement CT-320
  - Current iframe transport has TODO at
    iframe-sandbox/common-iframe-sandbox.ts:212
  - No version tracking causes overwrites with stale React state

## Open questions

- [ ] Debug tools we should build to support this future state
- [ ] Behavior for clients that are offline for a while and then come back
      online while there were changes. By default we'd just drop all of those,
      but we would notice that explicitly. Unlike rejections that happen quickly
      and users can react to in real-time, this might need something more
      sophisticated.
  - [ ] At the very least show a UI that we're offline. CT-445 tracks that.
- [ ] Recovery flows for e.g. corrupted caches (interrupted in the middle of an
      update)
- [ ] Extending transaction boundaries beyond single event handlers: As
      described above, each handler's execution and retry is independent of each
      other and it's possible that one of them is rejected while others pass,
      even for the same event. We could change this to broaden the transaction:
  - A fairly simple change would be to treat all handlers of the same event as
    one transaction. Currently scheduler executes them one-by-one and settles
    the state (i.e. run all the reactive functions) in between, and it wouldn't
    be difficult to change that to running all handlers for one event, then
    settle the state. That way, at least the event is either accepted or
    rejected as a whole. That said, I don't think we have any examples yet of
    running multiple handlers in parallel.
  - The more complex case would be a cascade of events, i.e. event handlers that
    issue more events, and then accepting/rejecting the entire cascade. That's
    significantly more complicated, and even more so if we allow async steps
    inbetween (like a fetch). We haven't seen concrete examples of this yet, and
    we should generally avoid this pattern in favor of reactive functions.
- [ ] Incremental loading: As currently stated all pending schema queries are
      expected to be resolved together. At least that is the easiest to model if
      the goal is to represent consistent state. But it also means that the
      initial load can take longer than needed, because it needs to load all the
      data. Clever ordering of queries, treating some as pending, etc. could
      improve this a lot, but is non-trivial. Fine for now, but something to
      observe.
- [ ] Anything we can do to make it easier to run handlers or functions in
      parallel if they have no shared dependencies?

## Design notes

### Functions must see a consistent state

We need to lock versions while executing a handler/reactive function? I.e. if an
update comes from the server after the function started, and `.get()` is called,
we need to return the state from the point when it was called? Considerations:

- It's almost certainly going to cause issues if the function sees data from
  different points of time, even if they are internally self consistent.
- We don't know which cells, especially which cells linked from cells the
  function will read, so making a copy of all of those is overkill.
- That said, the functions are meant to be synchronous without any awaits in it.
  We have exceptions (the importers) right now, but it's ok to behave as if they
  were (i.e. stop everything else). These might become async from the outside
  later, e.g. we can pause execution in a wasm sandbox to fetch more data across
  a Worker boundary or so.
- Hence, for now we can do the equivalent of `await runtime.idle()` before even
  processing data coming from the websocket, and thus circumvent this question.
  It really just timeshifts processing to after processing, and that's anyway
  the intended effect. In fact we should even apply the writes before processing
  server-side data, then everything will be based on the correct cause.

### Schema queries

Schema queries is how we maintain the invariant that a `.get()` on a cell should
return a consistent view _across_ several documents by fetching and updating
documents atomically. The schema lets us understand how to group these
documents. This replaces the current "crawler" mode in storage.ts, which what
most of the batch logic actually does.

Specifically we rely on the server observing a change in any of the documents
that were returned last time, rerun the query and send updates to the client
about all documents that are now returned by the query.

#### Schema queries & cache

We have to store queries in the cache as well, noting for which `since` we're
sure it is uptodate (`since` is monotonically increasing at the space level, so
representing time: A document has a value _since_ that time). In fact we want to
point to a session id (representing the current socket connection, since that
represents the time the client and server share state (IOW: For each new
connection the active queries have to be re-established, and then present the
next set of shared state again). It is just a local concept, so any random or
even monotonically increasing number will do) from each query, and the session
id notes the last `since`. That's because once a subscription is up, all we need
are new versions of documents, we don't need the association of which query they
belonged to. And so all currently active queries are always current to the last
update. (Once we also unsubscribe from queries this gets a little more complex)

So when a new query is issued, we

- issue the query to server with a `since` from the cache or `-1` (to be
  confirmed) indicating that it never ran.
- if it is in the cache run the query against the cache, and see whether any
  documents are newer than the `since` for the query. If not, we can serve the
  current cached version immediately. If yes, the state might be inconsistent
  and we have to wait for the server (in the future we might want to keep older
  versions for this reason)

The server builds state of what documents the client already has at what version
by running the queries server side _at that sent `since`_ and assuming that the
client already has all the documents for that `since`. It is hence advantageous
to send queries that are in the cache before any non-cached queries, to the
degree that is in our control. Maybe batch them for a microtick?

#### What happens if new data is needed

A handler or reactive function might change data in such a way that a subsequent
reactive function has a query as input that is now incomplete. We need to define
what should happen in this case.

An example is changing the currently selected item based on a list that has just
the names of the items and a detail view reacting to it that shows all details.
It might have to fetch the details now.

The two options are:

- Return `undefined` at the next highest point in the structure that is
  optional. Eventually the function will be called again with the full data.
  This seems reasonable, except if an event will be based on this incomplete
  data and thus write incomplete data back to the store -- CAS will catch most
  of these cases, but I can imagine UI roundtrips, especially if the user is
  acting on stale mental state and races the UI with a click, where this breaks.
- Skip execution entirely, effectively returning `<Pending>` and let higher
  layers deal with it. (A pattern we might want to adopt for `llm` and other
  calls as well, see CT-394)

Current implementation just returns `undefined` where data is missing and might
cause errors. We shouldn't block building the above on resolving this though.

## Future work that is related

### Changes to schema

- flip default interpretation of no `additionalProperties` to be `false` instead
  of `true` (which is what "ignore additional properties" means in a query
  context vs validation context)
- change `{}` schema to mean `false` (matching nothing) instead of `true` (any).
- use schema in cell links when resolving queries, at first only if schema is
  `true` otherwise.
- add `allOf` support and use it for schemas in cell links, so that it's now the
  intersection of schemas.

### Transition all links/etc to @-notation

- Blobs: See upcoming doc, noting here as it's building on moving to the
  `{ "@": { <type>: { ... }}}` notation of links/etc
- Charms: Add `{ "@": { process: { ... }}}` for charms, and make result just
  data within that (as it's always a few static aliases anyway). System code
  that deals with charms should probably directly operate on cells of processes
  like this. And code where charms are just pointers to results (most current
  code and all userland code) inherit the behavior from the now clear
  containment.
- Streams: Currently `{ $stream: true }` should also transition. I don't think
  any extra data is needed, though we might want to discuss moving the schema of
  the events into this vs storing it in the usual meta data for schemas.

### Save scheduling information in storage as meta data, remove extra `value`

Currently data in storage is actually
`{ value?: <the actual value>, source?: <id of process charm, if any> }`. It
should just be the value.

We also don't store any information that the scheduler generates about
dependencies, and so when loading a charm we have to recompute all reactive
functions just to regenerate that.

Instead we could save scheduling information as meta data, i.e. as a separate
document with a different `the`, but the same `of`.

For reactive functions we should store

- What data was read to compute this output and at what `since`
- Link to process cell that explains how to recompute this

For data last manipulated by an event we might just - if the event actually did
read the prior state - write itself as dependent data. This makes it so that the
rule to allow overwriting is "can't use any sources that are older than the
sources used to compute this value". The underlying CAS based on cause is then
just there to make sure this reasoning is based on the current last state.

For streams we want to write out all the processing cells that define handlers
for this stream, so that they can be reloaded.

### Changing recipe creation to just use `Cell` and get rid of `OpaqueRef`

`OpaqueRef` are just opaque `Cell`s. So we can vastly simplify recipe
generaetion by combining those.

Essentially `lift` & co return cells instead. And the opaque cell passed in to
the recipe function is already bound to the actual inputs (without revealing
that to the recipe function).

The tricky bit is generating good causal ids for these cells, which isn't good
right now either.

This could work like this:

- Build up a graph of cells, just like opaque refs now, via builder functions.
  Don't assign ids yet, so id-less cells is a new thing.
- Eventually they are either assigned to a pre-existing cell or they are
  returned (which is assigned to the result cell). Use this to derive ids, that
  are causal to invocation and where they write to (entity id + path).
- Do that recursively as ids are being set.
- For all remaining cells in the graph, i.e. those that are never read, we can
  assign them causal to the invocation and a sequence number or something else.
  As nothing can read them it matters less. FWIW, the only use-case so far is a
  `lift` that calls console.log, so strictly for debugging.

Note that with the change above of writing transactions this also implies
delayed writes. This is then also how the transaction object gets known to the
cell: When it connects to the rest of the graph and gets its id.

### Single event sourcing model + server-side query prediction

Instead of sending transactions to the server we can send the original events
instead and run the event handler server-side on what is guaranteed to be the
canonical state. Thus have a simpler event source system.

The code above becomes speculative execution that reapplies pending events on
newer data until it is fully in sync again.

Note that events can still conflict (unless they are inherently conflict-free of
course). The client-server API then changes to both sending events and getting
confirmation/rejections back. The client could reissue a new event in some rarer
cases, but sending the same event again won't be needed, as it was already run
on the current state. (That said, we can still support "sending an event" that
just a basic patch and then re-issue a new patch based on that. That's really
only useful for when we can't run the handler on the server, e.g. in some iframe
use-cases)

Note that since all reactive functions can run on the server as well, all that
work is latency reduction on the client and doesn't need to be synced. The
optimization is the other way around: If we know that a client will run these
reactive functions we don't need to send that state from the server (in fact
often we don't need to save it all, especially if recomputation is cheap, but
that's yet another future optimization). This falls under a larger opportunity
to look at a computation graph and decide which parts the client should even run
(e.g. prune parts that only feed into something that must run on the server,
e.g. any external fetches or API calls)

#### Possible bonus: Server could predict most queries

At this point knowing just a few things about the client, e.g. what UI is shown,
we can reconstruct enough of the remaining client state server-side to predict
what schema queries the client would send and just proactively run those and
sync the documents. The main problem here is that we don't know the state of the
cache. Maybe there is an anologous roll-up for cache state (which as noted above
is really a map from queries to `since`), e.g. just remembering the `since` for
a given place in the UI and the rest follows from there?
