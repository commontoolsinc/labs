# Subscriptions (WebSocket) Details

## Subscribe

**Subscribe** with either:

* `fromEpoch` (fast, server can query directly by `tx_id`), or
* `fromHeads` (server computes missing frontier from heads).

## Catch-up

1. Server queries `am_change_index` joined to `am_change_blobs` where `tx_id > fromEpoch` (or by seq range if using heads).
2. Groups changes by `(doc_id, branch_id)`.
3. Streams them in order of `tx_id` and within branch by `seq_no`.

## Batching

* Coalesce multiple changes into a single frame until ~64–256 KB to reduce WS chatter.

## Ack Model

* Client acks with the **highest `epoch` (tx_id)** fully processed per subscription.
* Server keeps a per-subscription ring buffer of unacked frames.
* On reconnect, the client sends `fromEpoch` = last acked epoch, and server resumes from there.

## Backpressure

* If unacked frames exceed `N` MB, server pauses sending to that subscription until more acks arrive.

## Delivery Semantics

* At-least-once delivery — client must be idempotent.
* Optional: multiplex raw Automerge Sync v2/v3 messages instead of change arrays; server runs per-subscription sync state machines.
