#!/bin/bash
while codex exec --sandbox=danger-full-access "$(cat packages/runner/integration/patterns/prompt.md)"; do
  echo "Run succeeded, retrying..."
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git stash push -m "$(git diff --stat | llm prompt 'Summarize these changes into a short git stash description')"
  fi
done
echo "Stopped because the command failed."

