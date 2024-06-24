#!/bin/bash

# Directory containing the source files
SRC_DIR="./"

# Output directory for documentation
DOC_DIR="./docs"

# Name of the combined context file
CONTEXT_FILE="combined_context.txt"

# Combine all .ts files into a single context file
find "$SRC_DIR" -name "*.ts" -type f -print0 | xargs -0 cat > "$CONTEXT_FILE"

# Create the docs directory if it doesn't exist
mkdir -p "$DOC_DIR"

# Iterate over each .ts file
for file in "$SRC_DIR"/*.ts; do
    if [ -f "$file" ]; then
        # Get the base name of the file (without path and extension)
        base_name=$(basename "$file" .ts)

        # Generate documentation
        ./generate_doc.sh "$CONTEXT_FILE" "$file" > "$DOC_DIR/$base_name.md"

        echo "Generated documentation for $base_name"
    fi
done

echo "Documentation generation complete."
