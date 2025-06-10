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
  recursively. This also means that changes from the upper layer can accumulate,
  and then altogether become one transaction. If there is one conflict anywhere,
  the entire transaction is rejected. And while the actual conflict source gets
  eventually updated (since the server will send these, and document that is
  read is also being subscribed to) the other documents that were locally
  changed are not reverted. The clients get out of sync.
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

- Ephemeral storage provider + Get rid of `VolatileStorageProvider` CT-420
- Schema queries for everything + Source support CT-174 CT-428
- Turn off "crawler" more in storage.ts
- Replace all direct use of `DocImpl` with `Cell` (only `DocImpl` use inside
  `Cell` should remain)
  - Includes changing all places that expect `{ cell: DocImpl, … }` to just use
    the JSON representation. At the same time, let's support the new syntax for
    links (@irakli has these in a RFC, should be extracted)
- Capture all cell writes in a pending list (this is also needed for a future
  recipe refactoring)
  - For reads after writes do return pending writes, so maybe we just apply
    writes anyway on a copy. then after flushing the pending writes (i.e. they
    get written to the nursery), we reset that until the next get. make sure
    this still work with `QueryResultProxy` (might have to retarget to changed
    objects). TBD: when to make copies, and can we work directly on the copy in
    the nursery?
  - Note that pending writes might contain `Cell` objects. Those would be
    converted to links in JSON
- Directly read & write to memory layer
  - Expose the API below current StorageProvider to `Cell`. That includes `Cell`
    setting the to application/json, etc.
  - Read: `Cell` bypasses DocImpl and just reads from memory
  - Scheduler: when listening to changes on entities, directly talk to memory
  - Writes: Commit writes after each handler or lift is run as transaction
- Remove `storage.ts` and `DocImpl`, they are now skipped
- For events, remember event and corresponding write transaction. Clear on
  success and retry N times on conflict. Retry means running the event handler
  again on the newest state (for lifted functions this happens automatically as
  they get marked dirty)
  - For change sets that only write (e.g. only push or set), we could just
    reapply it without re-running. But that's a future optimization.
  - Memory layer with pending changes after a conflicted write: rollback to heap
    and notify that as changes where it changed things
- Sanitize React at least a bit by implement CT-320
