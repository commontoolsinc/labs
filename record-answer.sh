#!/usr/bin/env bash
set -euo pipefail

QUESTIONS_DIR="docs/questions"
TEMPLATE="$QUESTIONS_DIR/_template.md"
INDEX="$QUESTIONS_DIR/index.json"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get today's date
TODAY=$(date +%Y-%m-%d)

# Prompt for question
echo -e "${BLUE}Enter your question:${NC}"
read -r QUESTION_TEXT

if [ -z "$QUESTION_TEXT" ]; then
    echo "Error: Question cannot be empty"
    exit 1
fi

# Search for similar questions using ripgrep
echo -e "\n${BLUE}Searching for similar questions...${NC}"
SIMILAR=$(rg -i -l "$QUESTION_TEXT" "$QUESTIONS_DIR"/*.md 2>/dev/null | grep -v "_template.md" || true)

if [ -n "$SIMILAR" ]; then
    echo -e "${YELLOW}Found potentially similar questions:${NC}"
    echo "$SIMILAR" | while read -r file; do
        title=$(rg "^# " "$file" | head -1 | sed 's/^# //')
        status=$(rg "^status: " "$file" | head -1 | sed 's/^status: //')
        echo "  - $(basename "$file") [$status]: $title"
    done

    echo -e "\n${BLUE}What would you like to do?${NC}"
    echo "1) Create new question anyway"
    echo "2) Update an existing question"
    echo "3) Mark existing as superseded and create new"
    echo "4) Cancel"
    read -r -p "Choice [1-4]: " CHOICE

    case $CHOICE in
        1)
            # Continue with new question
            ;;
        2)
            echo "Enter the filename to update (e.g., 2025-11-24-example.md):"
            read -r UPDATE_FILE
            if [ -f "$QUESTIONS_DIR/$UPDATE_FILE" ]; then
                # Update the 'updated' field
                sed -i '' "s/^updated: .*/updated: $TODAY/" "$QUESTIONS_DIR/$UPDATE_FILE"
                ${EDITOR:-vim} "$QUESTIONS_DIR/$UPDATE_FILE"
                echo -e "${GREEN}Updated $UPDATE_FILE${NC}"
                exit 0
            else
                echo "File not found: $UPDATE_FILE"
                exit 1
            fi
            ;;
        3)
            echo "Enter the filename to supersede (e.g., 2025-11-24-example.md):"
            read -r OLD_FILE
            if [ ! -f "$QUESTIONS_DIR/$OLD_FILE" ]; then
                echo "File not found: $OLD_FILE"
                exit 1
            fi
            # Continue with new question, we'll link them after
            ;;
        4)
            echo "Cancelled"
            exit 0
            ;;
        *)
            echo "Invalid choice"
            exit 1
            ;;
    esac
fi

# Generate slug from question
SLUG=$(echo "$QUESTION_TEXT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//' | cut -c1-50)
FILENAME="$TODAY-$SLUG.md"
FILEPATH="$QUESTIONS_DIR/$FILENAME"

# Check if file already exists
if [ -f "$FILEPATH" ]; then
    echo -e "${YELLOW}File $FILENAME already exists. Opening for edit...${NC}"
    ${EDITOR:-vim} "$FILEPATH"
    exit 0
fi

# Create new question file from template
cp "$TEMPLATE" "$FILEPATH"

# Update the metadata
sed -i '' "s/date: YYYY-MM-DD/date: $TODAY/" "$FILEPATH"
sed -i '' "s/updated: YYYY-MM-DD/updated: $TODAY/" "$FILEPATH"

# Insert question title and text
sed -i '' "s/^# Question Title/# $QUESTION_TEXT/" "$FILEPATH"
sed -i '' "/## Question/,/## Answer/{
    /## Question/a\\
\\
$QUESTION_TEXT
}" "$FILEPATH"

# If superseding an old question, update both files
if [ -n "${OLD_FILE:-}" ]; then
    NEW_BASENAME=$(basename "$FILEPATH")

    # Update new file to reference old file
    sed -i '' "s/supersedes: \[\]/supersedes: [$OLD_FILE]/" "$FILEPATH"

    # Update old file
    sed -i '' "s/status: .*/status: deprecated/" "$QUESTIONS_DIR/$OLD_FILE"
    sed -i '' "s/superseded_by: null/superseded_by: $NEW_BASENAME/" "$QUESTIONS_DIR/$OLD_FILE"
    sed -i '' "s/updated: .*/updated: $TODAY/" "$QUESTIONS_DIR/$OLD_FILE"

    echo -e "${GREEN}Marked $OLD_FILE as deprecated${NC}"
fi

# Update index.json
TEMP_INDEX=$(mktemp)
jq --arg filename "$FILENAME" \
   --arg date "$TODAY" \
   --arg title "$QUESTION_TEXT" \
   '.last_updated = $date | .questions += [{"filename": $filename, "date": $date, "title": $title, "status": "open"}]' \
   "$INDEX" > "$TEMP_INDEX"
mv "$TEMP_INDEX" "$INDEX"

echo -e "${GREEN}Created $FILENAME${NC}"
echo -e "${BLUE}Opening in editor...${NC}"

# Open in editor
${EDITOR:-vim} "$FILEPATH"

echo -e "${GREEN}Question recorded successfully!${NC}"
