#!/bin/bash

# Check if both arguments are provided
if [ $# -ne 2 ]; then
    echo "Usage: $0 <combined_context_file> <source_code_file>"
    exit 1
fi

# Function to escape JSON special characters
escape_json() {
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

# Read and escape the contents of the files
combined_context=$(cat "$1" | escape_json)
source_code=$(cat "$2" | escape_json)

# Construct the JSON payload
json_payload=$(cat <<EOF
{
"spell": [$combined_context, $source_code],
"system": "I want to produce clear documentation for a set of web components built with lit-html. I would like to cover each component, the attributes it exposes, it's intended purpose and examples of usage (combined with other components). The first message will contain the sourcecode of all components in one chunk, just respond with OK to that one, the second message will be the code of the specific component we're documenting in this pass."
}
EOF
)

# Send the POST request using curl and capture the response
response=$(curl -s -X POST \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$json_payload" \
    http://localhost:8000)

# Extract and unescape the text from the response using Python
output=$(python3 -c "
import json, sys
try:
    response = json.loads(sys.stdin.read())
    if 'output' in response and isinstance(response['output'], list) and len(response['output']) > 0:
        print(response['output'][0])
    else:
        print('Error: Unexpected response format')
except json.JSONDecodeError as e:
    print(f'Error decoding JSON: {e}', file=sys.stderr)
except Exception as e:
    print(f'Unexpected error: {e}', file=sys.stderr)
" <<< "$response")

# Print the unescaped output
echo "$output"
