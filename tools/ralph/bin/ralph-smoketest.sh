#!/usr/bin/env bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the ralph directory (parent of bin)
RALPH_DIR="$(dirname "$SCRIPT_DIR")"
# Get the labs directory (two levels up from bin)
LABS_DIR="$(dirname "$(dirname "$RALPH_DIR")")"

# Change to labs directory for relative paths to work
cd "$LABS_DIR"

# Check RALPH_ID is set
if [ -z "$RALPH_ID" ]; then
  echo "Error: RALPH_ID environment variable is not set"
  exit 1
fi

# Ensure logs directory exists
mkdir -p ./tools/ralph/logs

# Rotate logs keeping last 5
for i in 4 3 2 1; do
  [ -f ./tools/ralph/logs/ralph-claude.log.$i ] && mv ./tools/ralph/logs/ralph-claude.log.$i ./tools/ralph/logs/ralph-claude.log.$((i+1))
done
[ -f ./tools/ralph/logs/ralph-claude.log ] && mv ./tools/ralph/logs/ralph-claude.log ./tools/ralph/logs/ralph-claude.log.1

# llm command to summarize changes
LLM="./tools/ralph/bin/llm.sh"

# Extract task for this RALPH_ID from TASKS.md
TASK=$(awk -v id="$RALPH_ID" '
/^[0-9]+\. \[ \]/ {
  task_num = substr($1, 1, length($1)-1)
  if (task_num == id) {
    found = 1
    # Strip the "N. [ ] " prefix from first line
    sub(/^[0-9]+\. \[ \] /, "")
    print
    next
  }
}
found && /^[0-9]+\. \[ \]/ {
  exit
}
found {
  print
}
' ./tools/ralph/TASKS.md)

# If no task found, provide default message
if [ -z "$TASK" ]; then
  TASK="You have no task, just exit"
fi

# Replace <SMOKETEST_TASK> in prompt and pipe to claude
{
  printf "Your RALPH_ID is %s.\n\n" "$RALPH_ID"
  awk -v task="$TASK" '{
    if ($0 ~ /<SMOKETEST_TASK>/) {
      print task
    } else {
      print $0
    }
  }' ./tools/ralph/SMOKETEST_PROMPT.md
} | \
claude --print --dangerously-skip-permissions \
--verbose --output-format=stream-json 2>&1 | \
tee -a ./tools/ralph/logs/ralph-claude.log
