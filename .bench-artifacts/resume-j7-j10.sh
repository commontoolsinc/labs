#!/bin/bash
# Resume of run-sequence.sh after the j7-gate kill (sibling seat's loaded-mode
# finale spiked the box to load 161; the background task carrying the sequence
# was stopped at j7's gate — j1-j6 complete, j7 never started, teardown clean).
set -uo pipefail
cd /Users/berni/labs-worktrees/topics-benchmark
B=.bench-artifacts
gate() { "$B"/wait-load.sh 5 20 || echo "GATE TIMEOUT (proceeding; loads per run in ledger)"; }
gate; "$B"/run-topics.sh j7-off  off 9871 journey 20; "$B"/run-topics.sh j7-on   on  9872 journey 20
gate; "$B"/run-topics.sh j8-on   on  9872 journey 20; "$B"/run-topics.sh j8-off  off 9871 journey 20
gate; "$B"/run-topics.sh j9-off  off 9871 journey 20; "$B"/run-topics.sh j9-on   on  9872 journey 20
gate; "$B"/run-topics.sh j10-on  on  9872 journey 20; "$B"/run-topics.sh j10-off off 9871 journey 20
echo ALL_DONE
