#!/usr/bin/env bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the ralph directory (parent of bin)
RALPH_DIR="$(dirname "$SCRIPT_DIR")"
# Get the labs directory (two levels up from bin)
LABS_DIR="$(dirname "$(dirname "$RALPH_DIR")")"

# Change to labs directory for relative paths to work
cd "$LABS_DIR"

# Ensure logs directory exists
mkdir -p ./tools/ralph/logs

# Rotate logs keeping last 5
for i in 4 3 2 1; do
  [ -f ./tools/ralph/logs/ralph-claude.log.$i ] && mv ./tools/ralph/logs/ralph-claude.log.$i ./tools/ralph/logs/ralph-claude.log.$((i+1))
done
[ -f ./tools/ralph/logs/ralph-claude.log ] && mv ./tools/ralph/logs/ralph-claude.log ./tools/ralph/logs/ralph-claude.log.1

# llm command to summarize changes
LLM="./tools/ralph/bin/llm.sh"

while :; do
  cat ./tools/ralph/PROMPT.md | \
  claude --print --dangerously-skip-permissions \
  --verbose --output-format=stream-json 2>&1 | \
  tee -a ./tools/ralph/logs/ralph-claude.log

  # Auto-stash changes if any exist
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A

    # Generate commit message from staged changes
    commit_msg=$(git diff --staged | $LLM "Summarize these changes into a short one-line description, output just that one line")

    git stash push -m "$commit_msg"
  fi

  # Sleep for 60 seconds before next iteration (helps when no tasks remain)
  echo "Sleeping for 60 seconds before next iteration..."
  sleep 60
done

echo "Stopped because the command failed."
