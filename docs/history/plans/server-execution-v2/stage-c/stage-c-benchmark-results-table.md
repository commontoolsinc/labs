---
status: historical
created: 2026-08-17
archived: 2026-08-18
reason: "Stage-C evidence: one-line per-run extraction of the first benchmark (companion to stage-c-benchmark-report.md and stage-c-benchmark-results.json)."
---

| run | wl | arm | pass | n | p50 | p95 | median(test) | mean | min | max | wall s | load before | load after | ratio§4 | waves | budgetExh | authored | derived | store commits (by class) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| abl-f5 | chat | on | N | None | None | None | None | None | None | None | None | { 11.25 9.31 18.37 } | None | None | None | None | None | None | 143 {'authored': 50, 'derived': 93} |
| l1 | lunch | on | N | None | None | None | None | None | None | None | 363 | { 3.97 4.31 6.23 } | { 3.53 3.91 5.37 } | 1.72 | 44 | 40 | 25 | 43 | 68 {'authored': 25, 'derived': 43} |
| l1a | lunch | off | Y | None | None | None | None | None | None | None | 23 | { 2.95 4.17 6.25 } | { 3.97 4.31 6.23 } | None | None | None | None | None | 398 {'authored': 398} |
| l1b | lunch | off | Y | None | None | None | None | None | None | None | 12 | { 3.41 3.88 5.35 } | { 3.27 3.84 5.31 } | None | None | None | None | None | 398 {'authored': 398} |
| n1 | note | on | N | 20 | 12645.369 | 50076.773 | None | 21545.869 | 1649.332 | 87074.171 | 502 | { 5.45 7.59 12.04 } | { 7.36 6.47 9.26 } | 2.776 | 298 | 169 | 128 | 297 | 425 {'authored': 128, 'derived': 297} |
| n1a | note | off | Y | 20 | 3502.745 | 9798.263 | None | 4218.301 | 499.526 | 10478.48 | 105 | { 3.42 8.45 12.93 } | { 5.66 7.66 12.09 } | None | None | None | None | None | 989 {'authored': 989} |
| n1b | note | off | Y | 20 | 3998.346 | 7725.6 | None | 3750.132 | 603.168 | 9912.49 | 91 | { 6.85 6.38 9.21 } | { 4.76 5.87 8.73 } | None | None | None | None | None | 971 {'authored': 971} |
| n2 | note | on | N | None | None | None | None | None | None | None | 780 | { 3.27 3.77 5.24 } | { 3.84 3.33 4.18 } | 2.744 | 214 | 109 | 96 | 214 | 310 {'authored': 96, 'derived': 214} |
| n2b | note | off | Y | 20 | 4026.525 | 11931.946 | None | 4660.755 | 651.905 | 12184.838 | 115 | { 3.69 3.30 4.16 } | { 5.47 4.12 4.37 } | None | None | None | None | None | 989 {'authored': 989} |
| smoke0 | chat | off | Y | 3 | 394 | 677 | 394 | 477 | 360 | 677 | 33 | { 9.20 20.58 47.44 } | { 10.48 19.48 45.80 } | None | None | None | None | None | 251 {'authored': 251} |
| smoke0 | chat | on | N | None | None | None | None | None | None | None | 368 | { 10.56 18.78 44.79 } | { 18.51 19.49 35.77 } | 1.75 | 35 | 26 | 20 | 35 | 55 {'authored': 20, 'derived': 35} |
| t1 | chat | on | N | None | None | None | None | None | None | None | 340 | { 5.73 12.86 26.88 } | { 6.23 8.25 20.02 } | 1.8 | 36 | 19 | 20 | 36 | 56 {'authored': 20, 'derived': 36} |
| t1a | chat | off | Y | 20 | 328 | 1069 | 328 | 400.1 | 162 | 1069 | 61 | { 4.03 14.27 28.45 } | { 6.05 13.05 27.03 } | None | None | None | None | None | 608 {'authored': 608} |
| t1b | chat | off | Y | 20 | 477 | 921 | 477 | 504.1 | 288 | 921 | 66 | { 6.21 8.21 19.94 } | { 9.27 8.71 19.20 } | None | None | None | None | None | 608 {'authored': 608} |
| t2 | chat | on | N | None | None | None | None | None | None | None | 600 | { 3.90 5.56 8.52 } | { 2.94 4.39 6.48 } | 1.742 | 119 | 99 | 62 | 108 | 171 {'authored': 62, 'derived': 109} |
| t2b | chat | off | Y | 20 | 227 | 498 | 227 | 256.8 | 167 | 498 | 57 | { 2.94 4.39 6.48 } | { 3.21 4.25 6.28 } | None | None | None | None | None | 608 {'authored': 608} |
