---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Point-in-time Topics startup capture and offline validation of negotiated result-schema metadata deduplication."
---

# Topics startup: repeated result-schema metadata

A September 10 capture of the deployed Topics board identified repeated
document-root result schemas as a substantial part of its startup transfer.
Extending the existing sync schema table to those fields reduced the largest
response's compressed size by **40.6%**, with exact reconstruction of the entire
response. This is an offline transport result, not a measured reduction in
deployed startup latency.

## Capture and scope

- Client base: `74705eea1`, Apple M5 Max, macOS arm64, Deno 2.9.4.
- Estuary server: `a5ed830f06827ce1b9bc0dfbe0b6a023315f3268`.
- Board: 249 Topics. The command started the board and read its index using
  `cell get … index --step --select @`, avoiding the separate CLI mapped
  projection cost.
- Both ends used `serverExecution=false`, `modernCellRep=false`,
  `contentAddressedSchemas=true`, `readerSchemaPrecedence=true`,
  `commitPreconditions=true`, `computedCellIds=true`,
  `plainResultReceipts=true`, and `lazyMaterialization=true`.
- Existing CLI phase timers, memory frame logging, and the in-process CPU
  profiler were enabled. A diagnostic WebSocket observer additionally recorded
  actual message lengths; a transport receiver wrapper retained the large
  sync locally for offline replay. It changed no requested reads.

The command returned 249 addresses. Its incoming messages totaled 18,874,603
bytes after decompression and 4,416,796 bytes at the WebSocket message boundary.
The largest response carried 4,843 upserts: 18,202,576 uncompressed bytes and
4,275,563 received compressed bytes. The offline compressor reproduced a
4,275,513-byte envelope for the same text. The comparisons below use that same
local compressor for both arms rather than comparing different encoders.

The board startup phase took 4.588 seconds in this instrumented invocation.
It included fresh compilation work on this client base, so it is not a matched
comparison with earlier startup timings. The largest watch request spanned
about 2.13 seconds; about 0.35 seconds went into decompression, decoding,
schema expansion, and replica application, with additional diagnostic logging
overhead. Other clients and host load were
uncontrolled. These timings locate work; they are not benchmark samples.

## Why the existing `cid:` work does not remove these copies

Content-addressed schemas cover link schemas, pattern bindings, and selectors.
The runtime's `Runner.#updateResultSchemaMeta` separately stores the complete
result schema at the document root, beside `value`, `argument`, and `internal`.
The existing transport schema table also targets link schemas rather than this
metadata field.

A local control compiled and instantiated a new, two-field pattern with
`contentAddressedSchemas=true`. Its projected title link carried a
`{ "$ref": "cid:…" }` schema, while `getMetaRaw("schema")` returned the
complete object schema, structurally equal to the compiled result schema.
The duplication therefore also occurs on freshly created pieces; it is not
solely legacy stored links awaiting migration.

The captured response contained 499 result-schema metadata fields but only
four distinct schemas, repeated 249, 138, 111, and one times. Their serialized
JSON field sizes totaled 4,537,456 bytes. Other substantial fields were
`internal` (4,335,902 bytes) and `value` (6,895,238 bytes). These field sizes
describe the decoded capture and are not additive estimates of compressed
network traffic.

## Change and offline comparison

The patch extends the existing hash-verified, frame-local schema table. With
both `syncSchemaTableV2` and the additional `syncDocumentSchemasV1` capability
negotiated, repeated large `doc.schema` values travel once in `schemaTable`.
Each affected upsert carries `documentSchemaRef` outside its document. The
client restores the metadata before ordinary schema expansion and cache
application. The stored documents, versions, query roots, and startup
synchronization are unchanged. Older peers continue using inline metadata.

The replay expanded the captured response once, then sent that identical
input through both encoder modes, the real memory boundary codec, and the
actual gzip envelope helpers. Every output was decoded and expanded and
compared structurally with the complete original response. One warmup pair
was retained separately; seven measured pairs alternated arm order. No live
server or network was involved in the replay.

| Largest response | Existing encoding | Metadata table |
| --- | ---: | ---: |
| Uncompressed protocol bytes | 18,202,576 | 13,731,755 |
| Compressed envelope bytes | 4,275,513 | 2,540,960 |
| Complete reconstructed response | Identical | Identical |
| Local codec pipeline median | 400 ms | 381 ms |
| Local codec pipeline range | 396–408 ms | 335–579 ms |

The byte reduction is exact for this capture. The local processing result is
variable: patched decoding had larger outliers, and the warmup pair took
447 ms for existing encoding and 516 ms with metadata deduplication. This
does not establish a robust CPU or startup-latency improvement. The expected
benefit is less transfer work; a deployment must be measured before assigning
an end-to-end saving. The replay excludes server query evaluation, network
waiting, and client replica application.

## Validation and remaining work

The memory tests cover exact wire round trips, metadata-only responses and
effects, modern links, Fabric values in schema defaults, ordinary application
fields, small/unique/already-content-addressed schemas, and malformed or
forged table references. A real loopback server/client matrix covers absent,
false, and true client capabilities against enabled and disabled servers and
checks the restored documents in the watch view.

Repository formatting, lint, and type checks passed. The complete memory
package suite passed with 616 tests and 587 test steps.

Raw captures, the fresh-piece control, the replay harness, and both prototype
and final replay records remain in the local investigation artifacts; no Topic
content or private identity was included in this changeset. Extending `cid:`
storage to result-schema metadata remains a separate opportunity requiring
its own persistence, schema-closure delivery, and reader-compatibility work.
