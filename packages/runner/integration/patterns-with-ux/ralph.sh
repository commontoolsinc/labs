#!/bin/bash
while codex exec --sandbox=danger-full-access "$(cat packages/runner/integration/patterns-with-ux/prompt.md)" 2>&1 | tee -a ~/ralph-ux.log; do
  echo "Run succeeded, retrying..."
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git stash push -m "$(llm "Summarize these changes into a short one-line description, output just that one line: $(git diff --staged)")"
  fi
done
echo "Stopped because the command failed."
