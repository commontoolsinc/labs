#!/usr/bin/env bash

# llm.sh - Text-only LLM interface using Claude Code
#
# A lightweight alternative to llm (https://llm.datasette.io) that leverages
# your existing Claude Code installation. No additional API tokens required.
#
# Usage:
#   llm.sh "Your question here"              # Direct prompt
#   echo "data" | llm.sh "Analyze this"      # Piped input
#   cat file.txt | llm.sh "Summarize"        # File processing
#
# Note: Runs in text-only mode with all tools disabled for safety.
#       Slower than native llm but requires no additional setup.

# Check if input is piped
if [ -p /dev/stdin ]; then
    # Read from stdin
    input=$(cat)
    prompt="$* $input"
else
    # Use arguments as prompt
    prompt="$*"
fi

# Create a temporary directory for Claude Code
temp_dir=$(mktemp -d)
cd "$temp_dir"

# Run Claude Code with the prompt (--print for non-interactive, --disallowed-tools "*" prevents all tool use)
echo "$prompt" | claude --print --disallowed-tools "*" 2>/dev/null

# Cleanup
cd - > /dev/null
rm -rf "$temp_dir"
