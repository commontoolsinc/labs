# Measuring the settle loop's yield on a fabrichat room

A paired measurement of what the settle loop's macrotask yield
(`packages/runner/src/scheduler/settle.ts`, pull request 8782) does to a load of
a thirty-message fabrichat room. This directory is a harness on a branch of its
own and is not meant to merge.

Two arms. Arm `a` is this checkout, the branch under test. Arm `b` is a worktree
of the `main` commit the branch last merged, so the two differ by the yield
alone. Each arm runs its own toolshed and shell from its own checkout, on its
own copy of one seeded store.

Everything the measurement writes goes under `$SETTLE_YIELD_OUT`
(`~/settle-yield-measure` unless set), outside both checkouts.

## Steps

Run from the repository root. `H` is this directory.

```bash
H=perf-harness/settle-yield
source $H/env.sh

# 1. The baseline worktree.
git fetch origin main
git worktree add --detach "$REPO_B" "$(git merge-base HEAD origin/main)"

# 2. Both server pairs, each on an empty store. The shell's first build is
#    slow; servers.sh allows it 25 minutes.
$H/servers.sh a "$OUT/store-a"
$H/servers.sh b "$OUT/store-b-empty"

# 3. Seed the room on arm a's toolshed.
deno run -A --no-check --config deno.jsonc $H/seed-room.ts \
  --api-url "http://localhost:$((8000+OFF_A))/" --members 12 --messages 30 \
  --salt s1 --out "$OUT/room.json" --key "$OUT/starter.key" \
  > "$OUT/seed.log" 2>&1
grep 'seed-room\]' "$OUT/seed.log" | tail -3

# 4. Give arm b a copy of the seeded store. Both toolsheds are stopped for
#    the copy; the shells keep running.
$H/toolshed.sh a stop; $H/toolshed.sh b stop
cp -R "$OUT/store-a" "$OUT/store-seed"
cp -R "$OUT/store-a" "$OUT/store-b"
$H/toolshed.sh a start "$OUT/store-a"; $H/toolshed.sh b start "$OUT/store-b"

# 5. The first render of the room on each arm, which is also the first-load
#    pair, and the text a browser load waits for.
$H/pairs.sh render first 1 1 seq
$H/last-text.sh first1-a

# 6. Reloads in the Deno client, then loads in a headless browser.
$H/pairs.sh render r 1 8 seq
$H/pairs.sh browser w 1 24 seq

# 7. Tables.
python3 $H/render-table.py "$OUT/out" first1-a first1-b \
  $(for i in $(seq 1 8); do echo r$i-a r$i-b; done) | column -t -s$'\t'
python3 $H/settle-silence.py "$OUT/out" \
  $(for i in $(seq 1 8); do echo r$i-a r$i-b; done)
python3 $H/browser-table.py "$OUT/out" w 1 24
```

`pairs.sh` takes `seq` or `par`. `seq` runs a pair's arms one after the other
and alternates which goes first. `par` runs them at the same time, so that load
from elsewhere reaches both arms equally; it needs enough idle cores for two
toolsheds, two shells, and two clients at once.

## What the tables hold

- `render-table.py`: per Deno render, wall and CPU seconds, the longest settle
  span, the count and total time of the turns the loop handed back (`yieldN`,
  `yieldT`), action runs and their time, and the two longest receive silences
  from the frame log.
- `settle-silence.py`: per Deno render, the longest receive silence that
  overlaps the longest settle span, and the frames read and sent during that
  span. It aligns the frame log's clock with the span clock on the first watch
  request.
- `browser-table.py`: per browser load, seconds to the last message and to the
  settled view, the worker's settle span, the longest watch round trip, and the
  latency of the page's cell requests to the worker; then paired statistics, `a`
  minus `b`.

## Things that go wrong

- A seed on a busy machine loses sends to commit conflicts; the room then holds
  fewer than thirty messages. `last-text.sh` reads the last message from a
  render for that reason. A seed log with `CommitConvergenceError` in it is the
  sign.
- A second server pair started from the same checkout as the first rebuilds the
  first one's shell against the second one's toolshed. One checkout per arm,
  always.
- `servers.sh` on a port already in use stops whatever was there. Pick `OFF_A`
  and `OFF_B` so that `8000+offset` and `5173+offset` are free, and never
  offset 0.
- A browser load needs a Chrome the Astral launcher can start; on macOS under an
  agent sandbox that means running unsandboxed (`docs/development/TESTING.md`,
  "Browser tests in agent sandboxes").
- The settle span of arm `a` includes its turns. Compare `settleMax - yieldT`
  with arm `b`'s `settleMax`, or compare `runT`.
