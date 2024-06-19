#!/bin/bash

# Verify out/schema/ directory exists
if [ ! -d "out/schema/" ]; then
  mkdir -p "out/schema/"
fi

# Empty out/schema/ directory
rm -rf out/schema/*

# Read the files.csv file line by line
while IFS= read -r line || [[ -n "$line" ]]; do

    # Skip empty lines
    if [[ -z "$line" ]]; then
        continue
    fi

    echo "Running schema.txt for $line"
    # Run the llm command with the current line as the filename
    cat prompts/schema.txt | sed "s/\$filename/$line/g" | llm -m claude-3-opus > out/schema/$line.txt

done < files.csv