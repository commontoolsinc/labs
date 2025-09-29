#!/bin/bash
while :; do
  cat packages/runner/integration/patterns-with-ux/prompt.md \
    | claude --print --dangerously-skip-permissions --verbose \
        --output-format=stream-json \
    | tee -a ~/ralph-claude-ux.log
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git stash push -m "$(llm \
      "Summarize these changes into a short one-line description, \
output just that one line: $(git diff --staged)")"
  fi;
done
echo "Stopped because the command failed."
