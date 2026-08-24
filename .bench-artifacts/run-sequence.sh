#!/bin/bash
# The measured sequence: load-gate before each pair, back-to-back within a
# pair (the dossier §2/§4-note-1 discipline), order-balanced arms.
set -uo pipefail
cd /Users/berni/labs-worktrees/topics-benchmark
B=.bench-artifacts
gate() { "$B"/wait-load.sh 5 20 || echo "GATE TIMEOUT (proceeding; loads per run in ledger)"; }

# M1: the topics-navigation test file, 6 adjacent pairs, order balanced.
gate; "$B"/run-topics.sh t1-off off 9871 test;  "$B"/run-topics.sh t1-on  on  9872 test
gate; "$B"/run-topics.sh t2-on  on  9872 test;  "$B"/run-topics.sh t2-off off 9871 test
gate; "$B"/run-topics.sh t3-off off 9871 test;  "$B"/run-topics.sh t3-on  on  9872 test
gate; "$B"/run-topics.sh t4-on  on  9872 test;  "$B"/run-topics.sh t4-off off 9871 test
gate; "$B"/run-topics.sh t5-off off 9871 test;  "$B"/run-topics.sh t5-on  on  9872 test
gate; "$B"/run-topics.sh t6-on  on  9872 test;  "$B"/run-topics.sh t6-off off 9871 test

# M2: the instrumented topics journey, 10 adjacent pairs, order balanced,
# series n=20 at 2 s (the chat series cadence). 10 journeys per posture =
# the mission's n>=10 end-to-end journey samples per arm; the per-event
# series gives 10x20=200 echo/arrival samples per arm.
gate; "$B"/run-topics.sh j1-off  off 9871 journey 20; "$B"/run-topics.sh j1-on   on  9872 journey 20
gate; "$B"/run-topics.sh j2-on   on  9872 journey 20; "$B"/run-topics.sh j2-off  off 9871 journey 20
gate; "$B"/run-topics.sh j3-off  off 9871 journey 20; "$B"/run-topics.sh j3-on   on  9872 journey 20
gate; "$B"/run-topics.sh j4-on   on  9872 journey 20; "$B"/run-topics.sh j4-off  off 9871 journey 20
gate; "$B"/run-topics.sh j5-off  off 9871 journey 20; "$B"/run-topics.sh j5-on   on  9872 journey 20
gate; "$B"/run-topics.sh j6-on   on  9872 journey 20; "$B"/run-topics.sh j6-off  off 9871 journey 20
gate; "$B"/run-topics.sh j7-off  off 9871 journey 20; "$B"/run-topics.sh j7-on   on  9872 journey 20
gate; "$B"/run-topics.sh j8-on   on  9872 journey 20; "$B"/run-topics.sh j8-off  off 9871 journey 20
gate; "$B"/run-topics.sh j9-off  off 9871 journey 20; "$B"/run-topics.sh j9-on   on  9872 journey 20
gate; "$B"/run-topics.sh j10-on  on  9872 journey 20; "$B"/run-topics.sh j10-off off 9871 journey 20
echo ALL_DONE
