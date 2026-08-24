#!/bin/bash
# M4 standalone (m3-sequence.sh was stopped at its r2 gate after the p/r/m
# pattern rows proved a harness mismatch; pattern tests reran green via
# run-pattern.sh instead): the repo's canonical topic-board navigation
# benchmark, 3 order-balanced pairs, cap 900 s.
set -uo pipefail
cd /Users/berni/labs-worktrees/topics-benchmark
B=.bench-artifacts
gate() { "$B"/wait-load.sh 5 20 || echo "GATE TIMEOUT (proceeding; loads per run in ledger)"; }
gate; "$B"/run-suite.sh bnav1-off off 9871 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav1-on on 9872 bench integration/topic-board-navigation.bench.ts 900
gate; "$B"/run-suite.sh bnav2-on on 9872 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav2-off off 9871 bench integration/topic-board-navigation.bench.ts 900
gate; "$B"/run-suite.sh bnav3-off off 9871 bench integration/topic-board-navigation.bench.ts 900; "$B"/run-suite.sh bnav3-on on 9872 bench integration/topic-board-navigation.bench.ts 900
echo ALL_DONE_M4
