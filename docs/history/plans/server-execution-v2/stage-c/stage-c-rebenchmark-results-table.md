---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: one-line per-run extraction of the re-benchmark (companion to stage-c-rebenchmark-report.md and stage-c-rebenchmark-results.json)."
---

| run | wl | arm | pass | n | p50 | p95 | median(test) | mean | min | max | wall s | load before | load after | ratio§4 | waves | budgetExh | authored | derived | store commits (by class) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c1 | chat | on | Y | 20 | 9734 | 14020 | 9734 | 8992.8 | 4393 | 14020 | 272 | { 2.79 2.97 2.84 } | { 6.17 4.57 3.57 } | 2.047 | 131 | 777 | 64 | 131 | 195 {'authored': 64, 'derived': 131} |
| c1a | chat | off | Y | 20 | 242 | 400 | 242 | 256.2 | 151 | 400 | 61 | { 2.35 2.80 2.77 } | { 3.30 3.08 2.87 } | None | None | None | None | None | 608 {'authored': 608} |
| c1b | chat | off | Y | 20 | 221 | 288 | 221 | 216.8 | 160 | 288 | 55 | { 4.76 4.62 3.70 } | { 4.32 4.50 3.71 } | None | None | None | None | None | 612 {'authored': 612} |
| c2 | chat | on | Y | 20 | 7397 | 13805 | 7397 | 8130.9 | 5273 | 13805 | 251 | { 3.80 3.90 3.76 } | { 3.65 3.93 3.83 } | 2.141 | 137 | 739 | 64 | 137 | 201 {'authored': 64, 'derived': 137} |
| c2b | chat | off | Y | 20 | 220 | 367 | 220 | 217.2 | 164 | 367 | 55 | { 3.07 3.78 3.78 } | { 2.29 3.46 3.66 } | None | None | None | None | None | 612 {'authored': 612} |
| l1 | lunch | on | Y | None | None | None | None | None | None | None | 43 | { 4.48 4.51 3.75 } | { 4.41 4.47 3.77 } | 2.107 | 59 | 163 | 28 | 59 | 87 {'authored': 28, 'derived': 59} |
| l1a | lunch | off | Y | None | None | None | None | None | None | None | 17 | { 4.12 4.45 3.70 } | { 4.73 4.56 3.76 } | None | None | None | None | None | 398 {'authored': 398} |
| l1b | lunch | off | Y | None | None | None | None | None | None | None | 11 | { 3.57 4.28 3.72 } | { 4.08 4.36 3.76 } | None | None | None | None | None | 398 {'authored': 398} |
| l2 | lunch | on | Y | None | None | None | None | None | None | None | 57 | { 2.19 3.42 3.65 } | { 3.36 3.50 3.66 } | 2.148 | 58 | 180 | 27 | 58 | 86 {'authored': 27, 'derived': 59} |
| n1 | note | on | Y | 20 | 7266.908 | 17335.895 | None | 8651.917 | 1109.821 | 19420.811 | 214 | { 3.72 4.24 3.78 } | { 3.95 4.11 3.82 } | 3.065 | 331 | 349 | 129 | 331 | 460 {'authored': 129, 'derived': 331} |
| n1a | note | off | Y | 20 | 2980.859 | 8105.366 | None | 3504.343 | 542.53 | 9310.181 | 87 | { 3.99 4.33 3.75 } | { 4.57 4.42 3.84 } | None | None | None | None | None | 989 {'authored': 989} |
| n1b | note | off | Y | 20 | 3291.975 | 6960.9 | None | 3393.593 | 414.117 | 8264.466 | 82 | { 3.44 3.98 3.78 } | { 3.92 3.93 3.77 } | None | None | None | None | None | 989 {'authored': 989} |
| n2 | note | on | N | 20 | 7232.958 | 20429.603 | None | 9326.488 | 1353.664 | 23888.118 | 237 | { 3.28 3.47 3.65 } | { 3.54 3.62 3.68 } | 3.204 | 346 | 362 | 129 | 346 | 475 {'authored': 129, 'derived': 346} |
| n2b | note | off | Y | 20 | 2984.927 | 7288.07 | None | 3438.49 | 433.312 | 7722.539 | 80 | { 3.10 3.51 3.63 } | { 4.67 4.21 3.91 } | None | None | None | None | None | 989 {'authored': 989} |
