#!/bin/bash
# M3: the rest of the patterns topics suite, per file, 3 order-balanced
# ON/OFF pairs each, same W4 recipe via run-suite.sh. M4: the repo's own
# topic-board-navigation benchmark, 3 pairs, cap 900 s (browser bench with
# replayed segments; the cap is a wall-clock budget, not an event wait).
# Runs AFTER run-sequence.sh (shares ports 9871/9872).
set -uo pipefail
cd /Users/berni/labs-worktrees/topics-benchmark
B=.bench-artifacts
gate() { "$B"/wait-load.sh 5 20 || echo "GATE TIMEOUT (proceeding; loads per run in ledger)"; }

# topic-create-onscreen (server + browser instrument-test; SIZE default 5)
gate; "$B"/run-suite.sh o1-off off 9871 test integration/topic-create-onscreen.test.ts; "$B"/run-suite.sh o1-on on 9872 test integration/topic-create-onscreen.test.ts
gate; "$B"/run-suite.sh o2-on on 9872 test integration/topic-create-onscreen.test.ts; "$B"/run-suite.sh o2-off off 9871 test integration/topic-create-onscreen.test.ts
gate; "$B"/run-suite.sh o3-off off 9871 test integration/topic-create-onscreen.test.ts; "$B"/run-suite.sh o3-on on 9872 test integration/topic-create-onscreen.test.ts

# topic-board-fixture (pure unit; runs under the same recipe for uniform posture attestation)
gate; "$B"/run-suite.sh f1-off off 9871 test integration/topic-board-fixture.test.ts; "$B"/run-suite.sh f1-on on 9872 test integration/topic-board-fixture.test.ts
gate; "$B"/run-suite.sh f2-on on 9872 test integration/topic-board-fixture.test.ts; "$B"/run-suite.sh f2-off off 9871 test integration/topic-board-fixture.test.ts
gate; "$B"/run-suite.sh f3-off off 9871 test integration/topic-board-fixture.test.ts; "$B"/run-suite.sh f3-on on 9872 test integration/topic-board-fixture.test.ts

# topics pattern tests (single-runtime happy/legacy paths)
gate; "$B"/run-suite.sh p1-off off 9871 test topics/topics.test.tsx; "$B"/run-suite.sh p1-on on 9872 test topics/topics.test.tsx
gate; "$B"/run-suite.sh p2-on on 9872 test topics/topics.test.tsx; "$B"/run-suite.sh p2-off off 9871 test topics/topics.test.tsx
gate; "$B"/run-suite.sh p3-off off 9871 test topics/topics.test.tsx; "$B"/run-suite.sh p3-on on 9872 test topics/topics.test.tsx

# topics rejection-path pattern tests
gate; "$B"/run-suite.sh r1-off off 9871 test topics/topics-rejections.test.tsx; "$B"/run-suite.sh r1-on on 9872 test topics/topics-rejections.test.tsx
gate; "$B"/run-suite.sh r2-on on 9872 test topics/topics-rejections.test.tsx; "$B"/run-suite.sh r2-off off 9871 test topics/topics-rejections.test.tsx
gate; "$B"/run-suite.sh r3-off off 9871 test topics/topics-rejections.test.tsx; "$B"/run-suite.sh r3-on on 9872 test topics/topics-rejections.test.tsx

# topics multi-user pattern tests (two worker-isolated runtimes)
gate; "$B"/run-suite.sh m1-off off 9871 test topics/multi-user.test.tsx; "$B"/run-suite.sh m1-on on 9872 test topics/multi-user.test.tsx
gate; "$B"/run-suite.sh m2-on on 9872 test topics/multi-user.test.tsx; "$B"/run-suite.sh m2-off off 9871 test topics/multi-user.test.tsx
gate; "$B"/run-suite.sh m3-off off 9871 test topics/multi-user.test.tsx; "$B"/run-suite.sh m3-on on 9872 test topics/multi-user.test.tsx

echo M3_DONE

# M4: the repo's canonical topic-board navigation benchmark (deno bench,
# 30-topic board, 5 iterations + 1 warmup per segment).
gate; "$B"/run-suite.sh bnav1-off off 9871 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav1-on on 9872 bench integration/topic-board-navigation.bench.ts 900
gate; "$B"/run-suite.sh bnav2-on on 9872 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav2-off off 9871 bench integration/topic-board-navigation.bench.ts 900
gate; "$B"/run-suite.sh bnav3-off off 9871 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav3-on on 9872 bench integration/topic-board-navigation.bench.ts 900

echo ALL_DONE_M3M4
