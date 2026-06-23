#!/usr/bin/env bash
#
# seed.sh — seed a LOCAL lunch-poll with the canonical rapids snapshot.
#
# The fixtures in ./data/ were pulled from the rapids staging poll
#   piece  fid1:bb9YQo5g-9B0o9Nx_cR9sR5qA8oxEkFA5AYUlC84EwE
#   space  lunch-2026-06-23
# on 2026-06-23: 10 options (each with inline base64 webp art), 35 votes
# (green/yellow/red = 18/10/7), 4 users (Gideon, Danfuzz, Berni (remote), Alex).
#
# All poll state (question/city/adminName/options/votes/users) is a PerSpace
# INPUT field, so we write it with `cf piece set --input`. Without --input the
# write targets the computed *result* proxy and whole-array writes silently
# no-op (scalars happen to stick, arrays do not) — that is the one real gotcha.
#
# Usage:
#   ./seed.sh                      # deploy a FRESH seeded poll, print its URL
#   ./seed.sh --piece <fid1:...>   # reseed an existing piece in place (fast)
#   ./seed.sh --no-art             # strip option imageUrl (load A/B: art vs none)
#   ./seed.sh --empty              # zero options/votes/users (pure-boot baseline)
#   ./seed.sh --space NAME --api-url URL --identity PATH --pattern FILE
#
# Env defaults: CF_API_URL (http://localhost:8000), CF_IDENTITY (<repo>/cf.key).
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HERE/data"
REPO="$(cd "$HERE/../../../.." && pwd)"

API_URL="${CF_API_URL:-http://localhost:8000}"
IDENTITY="${CF_IDENTITY:-$REPO/cf.key}"
SPACE="lunch-local"
PATTERN="$REPO/packages/patterns/lunch-poll/main.tsx"
PIECE=""
MODE="full"   # full | noart | empty

while [ $# -gt 0 ]; do
  case "$1" in
    --piece)    PIECE="$2"; shift 2;;
    --space)    SPACE="$2"; shift 2;;
    --api-url)  API_URL="$2"; shift 2;;
    --identity) IDENTITY="$2"; shift 2;;
    --pattern)  PATTERN="$2"; shift 2;;
    --no-art)   MODE="noart"; shift;;
    --empty)    MODE="empty"; shift;;
    -h|--help)  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2;;
  esac
done

# Run the source CLI from the repo root so paths and deno.json resolve.
cf() { ( cd "$REPO" && deno run -A packages/cli/mod.ts "$@" -a "$API_URL" -i "$IDENTITY" ); }

set_file() { # field, json-file
  cat "$2" | cf piece set --input --quiet --piece "$PIECE" -s "$SPACE" "$1" >/dev/null 2>&1 \
    && echo "  set $1" || echo "  FAILED to set $1"
}
set_lit()  { # field, literal-json
  printf '%s' "$2" | cf piece set --input --quiet --piece "$PIECE" -s "$SPACE" "$1" >/dev/null 2>&1 \
    && echo "  set $1 = $2" || echo "  FAILED to set $1"
}

# --- deploy fresh unless reseeding an existing piece -------------------------
if [ -z "$PIECE" ]; then
  echo "Deploying fresh lunch-poll to space '$SPACE' ($API_URL) ..."
  out="$(cf piece new "$PATTERN" -s "$SPACE" 2>&1)" || { echo "$out"; exit 1; }
  # Parse the piece id from the "Open in browser" line specifically — other
  # lines (e.g. transformer warnings) can also contain a fid1: path.
  PIECE="$(printf '%s\n' "$out" | grep -i 'open in browser' | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)"
  [ -n "$PIECE" ] || { echo "Could not parse piece id from cf output:"; echo "$out"; exit 1; }
  echo "  created $PIECE"
fi

# --- options payload per mode ------------------------------------------------
opts_tmp="$(mktemp)"; trap 'rm -f "$opts_tmp"' EXIT
case "$MODE" in
  full)  cp "$DATA/options.json" "$opts_tmp";;
  noart) python3 -c "import json;o=json.load(open('$DATA/options.json'));[x.pop('imageUrl',None) for x in o];json.dump(o,open('$opts_tmp','w'))";;
  empty) echo '[]' > "$opts_tmp";;
esac

# --- seed --------------------------------------------------------------------
echo "Seeding piece $PIECE (mode=$MODE) ..."
set_file question  "$DATA/question.json"
set_file city      "$DATA/city.json"
set_file adminName "$DATA/adminName.json"
set_file options   "$opts_tmp"
if [ "$MODE" = empty ]; then
  set_lit votes '[]'
  set_lit users '[]'
else
  set_file votes "$DATA/votes.json"
  set_file users "$DATA/users.json"
fi
set_lit myName '"Gideon"'    # PerUser, this identity — view as the joined host
cf piece step --piece "$PIECE" -s "$SPACE" >/dev/null 2>&1

# --- verify + report ---------------------------------------------------------
echo "Verify:"
for c in optionCount voteCount userCount isJoined; do
  printf '  %-12s = %s\n' "$c" "$(cf piece get --piece "$PIECE" -s "$SPACE" "$c" 2>/dev/null)"
done
echo ""
echo "URL: $API_URL/$SPACE/$PIECE"
