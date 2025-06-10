# Unifying the storage stack

## Current state

Right now we have a few overlapping and uncoordinated layers of storage related
functionality that needs reconciling. Most importantly we see data loss since
the transaction boundaries don't line up, but it's also a lot of code that can
be simplified away.

Specifically we have:

- I/O over iframe boundaries, typically with the iframes running React, which in
  turn assumes synchronous state. So data can roundtrip through iframe/React and
  overwrite newer data that came in in the meantime.
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
  recursively. It also fetches all source docs. This also means that changes
  from the upper layer can accumulate, and then altogether become one
  transaction. If there is one conflict anywhere, the entire transaction is
  rejected. And while the actual conflict source gets eventually updated (since
  the server will send these, and document that is read is also being subscribed
  to) the other documents that were locally changed are not reverted. The
  clients get out of sync.
  - We now also have schema queries, which will immediately fetch all documents
    that are needed per a given schema, and will keep those up to date, even if
    links change. That could already replace a lot of the logic above, but we
    haven't turned that off. It also currently doesn't use the cache.
- storage/cache.ts, the memory layer, which operates at the unit of documents,
  supports CAS semantics for transactions. It's used by storage.ts only and
  while it has stronger guarantees, those either don't apply or sometimes
  backfire because they are not aligned with the top. It has a cache but we
  underuse it.

## Desired state

- Iframe transport layer sends incrementing versions and ignores changes that
  are based on too old changes. It's then up to the inside of the iframe to use
  that correctly. In fact `useDoc()` where `setX()` takes a callback instead of
  just the new value would already work much better. Probably sufficiently well
  for most cases. But we could go even further (maybe some popular game toolkits
  are worth investing here at some point in the future, since that's a good
  usecase for iframes)
- Cells –- constructed typically by the runner when bringing up a recipe, within
  handlers or reactive functions and in some cases by parts of the shell to
  bootstrap things -- directly read from memory via schema query. They
  accumulate writes and wait for the scheduler to close out a transaction.
  Interim reads see the new version.
- Scheduler runs handlers and reactive functions and then issues a transaction
  with pending writes directly to the underlying memory layer (we already log
  reads and writes, so this can be an extension of that). It registers with the
  underlying memory layer for changes on individual documents, marking the
  corresponding reactive functions as needing to run (semantically we want to
  subscribe to the corresponding schema queries, but at least with the current
  queries, listening to the actually read docs is the same). For events it will
  keep track of the transaction and if it fails, and after we're sure to have
  caught up enough with the server to reflect the new current state, retry up to
  N times.
- Memory -- more or less like now, except that its lower level API is directly
  exposed to cells, including `the` and the document ids as DIDs (so the Cell
  will have to translate the ids an prepend `of:`)

## Steps to get there

- [ ] Ephemeral storage provider + Get rid of `VolatileStorageProvider` CT-420
- [ ] Schema queries for everything + Source support CT-174 CT-428
- [ ] Turn off "crawler" more in storage.ts, make sure things still work
- [ ] Replace all direct use of `DocImpl` with `Cell` (only `DocImpl` use inside
      `Cell` should remain)
  - [ ] Includes changing all places that expect `{ cell: DocImpl, … }` to just
        use the JSON representation. At the same time, let's support the new
        syntax for links (@irakli has these in a RFC, should be extracted)
- [ ] Capture all cell writes in a pending list (this is also needed for a
      future recipe refactoring)
  - [ ] For reads after writes do return pending writes, so maybe we just apply
        writes anyway on a copy. then after flushing the pending writes (i.e.
        they get written to the nursery), we reset that until the next get. make
        sure this still work with `QueryResultProxy` (might have to retarget to
        changed objects). TBD: when to make copies, and can we work directly on
        the copy in the nursery?
  - [ ] Note that pending writes might contain `Cell` objects. Those would be
        converted to links in JSON
- [ ] Directly read & write to memory layer
  - [ ] Expose the API below current StorageProvider to `Cell`. That includes
        `Cell` setting the to application/json, etc., probably a subset of
        `Replica`.
  - [ ] Add an `await runtime.idle()` equivalent before processing data from web
        socket (see design note below)
  - [ ] Read: `Cell` bypasses DocImpl and just reads from memory
  - [ ] Scheduler: when listening to changes on entities, directly talk to
        memory
  - [ ] Writes: Commit writes after each handler or lift is run as transaction
- [ ] Remove `storage.ts` and `DocImpl`, they are now skipped
- [ ] For events, remember event and corresponding write transaction. Clear on
      success and retry N times on conflict. Retry means running the event
      handler again on the newest state (for lifted functions this happens
      automatically as they get marked dirty)
  - [ ] For change sets that only write (e.g. only push or set), we could just
        reapply it without re-running. But that's a future optimization.
  - [ ] Memory layer with pending changes after a conflicted write: rollback to
        heap and notify that as changes where it changed things
- [ ] Sanitize React at least a bit by implement CT-320

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
return a consistent view _across_ several documents. This replaces the current
"crawler" mode in storage.ts, which what most of the batch logic actually does.

Specifically we rely on the server observing a change in any of the documents
that were returned last time, rerun the query and send updates to the client
about all documents that are now returned by the query.

#### Schema queries & cache

We have to store queries in the cache as well, noting for which `since` we're
sure it is uptodate. In fact we want to point to a session id from each query,
and the session id notes the last `since`. That's because once a subscription is
up, all we need are new versions of documents, we don't need to association of
which query they belonged to. And so all currently active queries are always
current to the last update.

So when a new query is issued, we

- issue the query to server with a `since` from the cache or `-1` (to be
  confirmed) indicating that it never ran.
- if it is in the cache run the query against the cache, and see whether any
  documents are newer than the `since` for the query. If not, we can server the
  current cached version immediately. If yes, the state might be inconsistent
  and we have to wait for the server (in the future we might want to keep older
  versions for this reason)

The server builds state of what documents the client already has at what version
by running the queries locally and assuming that the client already has all the
documents for the sent `since`. It is hence advantageous to send queries that
are in the cache before any non-cached queries, to the degree that is in our
control. Maybe batch them for a microtick?

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

### Changing recipe creation to just use `Cell` and get rid of `OpaqueRef`

The accumulation of writes when running a reactive function / handler allows us
to create a graph of pending cells in them and treat those as a recipe. With the
addition of marking cells as opaque we then have all the functionality of
`OpaqueRef` and can replace all of that code.

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
