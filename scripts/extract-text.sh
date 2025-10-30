#!/usr/bin/env bash
grep --line-buffered -E '^\{"type":"assistant"' "$@" | jq --unbuffered -r '.message.content[]? | select(.type=="text") | .text'
