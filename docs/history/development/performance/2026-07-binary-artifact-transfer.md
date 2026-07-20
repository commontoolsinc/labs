---
status: historical
created: 2026-07-20
archived: 2026-07-20
reason: "Transfer snapshot used to evaluate splitting the Deno Workflow binary artifact."
---

# Binary artifact transfer snapshot, July 20, 2026

## Result

The latest successful `main` Deno Workflow run was
[`29765072099`](https://github.com/commontoolsinc/labs/actions/runs/29765072099)
for commit `b480270dd5d8f246e70b9b50d7e0cba26d14f399`. Its
`common-binaries` artifact was 252,900,276 bytes.

On a `main` run, downstream jobs currently download 51 binary files in 17
artifact downloads. Those downloads transfer 4,299,304,692 bytes. Separate
artifacts reduce this to 23 binary files in 23 artifact downloads and
2,025,452,983 bytes. The change removes 28 unnecessary binary-file transfers
and 2,273,851,709 bytes, or 52.89 percent of the downstream binary download
traffic.

Including the build upload, a `main` run currently transfers 54 binary files
and 4,552,204,968 artifact bytes. The split workflow transfers 26 binary files
and 2,278,353,303 artifact bytes. That full-run comparison saves 28 file
transfers and 2,273,851,665 bytes, or 49.95 percent. The 44-byte difference
between the downstream and full-run savings is the extra ZIP framing needed
for three upload artifacts instead of one.

## Artifact sizes

The file count in this report counts binary payloads crossing the artifact
boundary. The byte count is the compressed artifact archive size transferred
over the network, not the expanded size on the runner.

| Binary | Expanded bytes | Compressed ZIP entry bytes | Separate artifact bytes |
| --- | ---: | ---: | ---: |
| `toolshed` | 369,717,265 | 96,633,927 | 96,634,057 |
| `bg-piece-service` | 279,351,903 | 77,424,113 | 77,424,259 |
| `cf` | 285,838,024 | 78,841,886 | 78,842,004 |
| **Total** | **934,907,192** | **252,899,926** | **252,900,320** |

The current combined artifact adds 350 bytes of ZIP framing to its compressed
entries. The three separate artifacts add 394 bytes in total. The separate
artifact sizes therefore model the same binaries and compression from today's
run with the filenames and ZIP layout that the split workflow will use.

## Downstream transfer calculation

| Consumer | Job copies | Current files | Current bytes | Split files | Split bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Package integration | 3 | 9 | 758,700,828 | 3 | 289,902,171 |
| CLI integration | 4 | 12 | 1,011,601,104 | 8 | 701,904,244 |
| Pattern integration | 4 | 12 | 1,011,601,104 | 4 | 386,536,228 |
| Pattern unit | 5 | 15 | 1,264,501,380 | 5 | 394,210,020 |
| Binary attestation | 1 | 3 | 252,900,276 | 3 | 252,900,320 |
| **`main` total** | **17** | **51** | **4,299,304,692** | **23** | **2,025,452,983** |

Package integration and pattern integration use only `toolshed`. Pattern unit
uses only `cf`. CLI integration uses `toolshed` and `cf`. Binary attestation
uses all three binaries.

A pull request does not run binary attestation. Its downstream comparison is
48 files and 4,046,404,416 bytes today, versus 20 files and 1,772,552,663
bytes after the split. Including the upload changes those pull request totals
to 51 files and 4,299,304,692 bytes today, versus 23 files and 2,025,452,983
bytes after the split.

The artifact request count rises because consumers that need two or three
binaries make one request per binary. On `main`, downloads rise from 17 to 23,
while uploads rise from one to three. The lower payload size is the intended
trade-off. Future binary content changes will change the byte totals, while
the file counts remain fixed until the job matrices or binary dependencies
change.
