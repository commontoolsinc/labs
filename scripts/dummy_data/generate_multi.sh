#!/bin/bash

# Set default value for schema_file
schema_file="prompts/schema.txt"

# Check if an argument is provided
if [ $# -eq 1 ]; then
    schema_file=$1
    echo "Using schema file: $schema_file"
fi

# Get the basename of the schema file without the extension
output_dir="out/$(basename "$schema_file" .txt)"

# Verify output directory exists
if [ ! -d "$output_dir" ]; then
  mkdir -p "$output_dir"
fi

# Empty output directory
rm -rf "$output_dir"/*

# Read the files.csv file line by line
while IFS= read -r line || [[ -n "$line" ]]; do

    # Skip empty lines
    if [[ -z "$line" ]]; then
        continue
    fi

    echo "Running schema file for $line"
    # Run the llm command with the current line as the filename
    cat "$schema_file" | sed "s/\$filename/$line/g" | llm -m claude-3-opus > "$output_dir/$line.txt"

done < files.csv