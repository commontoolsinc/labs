# Streaming External Data

`streamData<T>()` consumes a server-sent event stream. It is a reactive node,
not a promise: never `await` it. The call returns the clean-close result as an
`AsyncResult<T>` and associates a live event channel selected with
`partialResultOf()`.

The type argument is required. `T` describes a complete decoded event and the
transformer derives the runtime validation schema from it.

```typescript
// Shown for illustration only.
type ProgressEvent = {
  id: string;
  event: string;
  data: { completed: number; total: number };
};

const request = streamData<ProgressEvent>({ url });
const finalEvent = resultOf(request);
const liveRequest = partialResultOf(request);
const liveEvent = resultOf(liveRequest);

return isPending(liveRequest)
  ? <p>Connecting...</p>
  : hasError(liveRequest)
  ? <p>Stream failed: {liveRequest.error.message}</p>
  : <p>{liveEvent.data.completed} / {liveEvent.data.total}</p>;
```

Both the direct request and partial request begin pending. Each decoded event
updates the partial request. The direct request remains pending until the
stream closes cleanly, then becomes the last decoded event. A stream which is
expected to remain open normally consumes only `partialResultOf(request)`;
`finalEvent` is useful only after a clean close.

A clean close before the first event, an unsuccessful HTTP response, a
connection failure, malformed event data, or invalid JSON produces an error on
both channels. An event that does not match `T` produces `schema-mismatch` on
both. The runtime does not reconnect automatically. Changing `url`, `options`,
or the inferred event schema starts a new request and resets both channels to
pending.

If the UI should retain the last usable event while a replacement connects or
after a failure, opt into that continuity explicitly:

```typescript
// Shown for illustration only.
const lastUsableEvent = latestComplete(partialResultOf(request));
```

`latestComplete()` starts pending until the first complete event and thereafter
keeps its last complete snapshot. The original request remains available for
`isPending()`, `hasError()`, and the other availability guards.
