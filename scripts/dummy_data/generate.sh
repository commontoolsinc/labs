#!/bin/bash

# Set default value for max_lines
max_lines=-1

# Check if an argument is provided
if [ $# -eq 1 ]; then
    max_lines=$1
    echo "Setting maximum number of lines to $max_lines"
fi

# Verify out/schema/ directory exists
if [ ! -d "out/schema/" ]; then
  mkdir -p "out/schema/"
fi

# Empty out/schema/ directory
rm -rf out/schema/*

# Initialize line counter
line_count=0

# Read the files.csv file line by line
while IFS= read -r line || [[ -n "$line" ]]; do

    # Skip empty lines
    if [[ -z "$line" ]]; then
        continue
    fi

    echo "Running schema.txt for $line"
    # Run the llm command with the current line as the filename
    cat prompts/schema.txt | sed "s/\$filename/$line/g" | llm -m claude-3-haiku > out/schema/$line.txt

    # Increment line counter
    line_count=$((line_count + 1))

    # Check if maximum number of lines reached
    if [ $max_lines -ge 0 ] && [ $line_count -ge $max_lines ]; then
        echo "Maximum number of lines ($max_lines) reached. Exiting."
        break
    fi
done < files.csv
