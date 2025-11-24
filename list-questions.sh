#!/usr/bin/env bash
set -euo pipefail

QUESTIONS_DIR="docs/questions"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get today's date for age calculation
TODAY=$(date +%Y-%m-%d)
TODAY_EPOCH=$(date -j -f "%Y-%m-%d" "$TODAY" "+%s")

# Calculate age in days
calc_age() {
    local date=$1
    local date_epoch=$(date -j -f "%Y-%m-%d" "$date" "+%s" 2>/dev/null || echo "0")
    local days=$(( (TODAY_EPOCH - date_epoch) / 86400 ))
    echo "$days"
}

# Format age for display
format_age() {
    local days=$1
    if [ "$days" -gt 180 ]; then
        echo -e "${RED}${days}d${NC}"
    elif [ "$days" -gt 90 ]; then
        echo -e "${YELLOW}${days}d${NC}"
    else
        echo -e "${GREEN}${days}d${NC}"
    fi
}

# Usage
usage() {
    echo "Usage: $0 [filter] [value]"
    echo ""
    echo "Filters:"
    echo "  open        List open questions (default)"
    echo "  answered    List answered questions"
    echo "  deprecated  List deprecated questions"
    echo "  aged        List questions with age warnings (>6 months)"
    echo "  tag <tag>   List questions with specific tag"
    echo "  all         List all questions"
    echo ""
    echo "Examples:"
    echo "  $0                    # List open questions"
    echo "  $0 answered           # List answered questions"
    echo "  $0 tag workflow       # List questions tagged 'workflow'"
    exit 1
}

# Parse arguments
FILTER="${1:-open}"
VALUE="${2:-}"

if [ "$FILTER" = "help" ] || [ "$FILTER" = "-h" ] || [ "$FILTER" = "--help" ]; then
    usage
fi

# Find question files
QUESTION_FILES=$(find "$QUESTIONS_DIR" -name "*.md" ! -name "_template.md" ! -name "README.md" | sort -r)

if [ -z "$QUESTION_FILES" ]; then
    echo "No questions found in $QUESTIONS_DIR"
    exit 0
fi

# Header
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                          Question List ($FILTER)                          ${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

COUNT=0

# Process each file
while IFS= read -r file; do
    # Skip if file doesn't exist
    [ -f "$file" ] || continue

    # Extract metadata
    DATE=$(rg "^date: " "$file" | head -1 | sed 's/^date: //' || echo "unknown")
    UPDATED=$(rg "^updated: " "$file" | head -1 | sed 's/^updated: //' || echo "$DATE")
    STATUS=$(rg "^status: " "$file" | head -1 | sed 's/^status: //' || echo "unknown")
    TAGS=$(rg "^tags: " "$file" | head -1 | sed 's/^tags: //' || echo "[]")
    AGE_WARNING=$(rg "^age_warning: " "$file" | head -1 | sed 's/^age_warning: //' || echo "false")
    TITLE=$(rg "^# " "$file" | head -1 | sed 's/^# //' || echo "Untitled")
    BASENAME=$(basename "$file")

    # Apply filters
    SHOW=false
    case $FILTER in
        open)
            [ "$STATUS" = "open" ] && SHOW=true
            ;;
        answered)
            [ "$STATUS" = "answered" ] && SHOW=true
            ;;
        deprecated)
            [ "$STATUS" = "deprecated" ] && SHOW=true
            ;;
        aged)
            [ "$AGE_WARNING" = "true" ] && SHOW=true
            ;;
        tag)
            if [ -z "$VALUE" ]; then
                echo "Error: tag filter requires a value"
                exit 1
            fi
            echo "$TAGS" | grep -q "$VALUE" && SHOW=true
            ;;
        all)
            SHOW=true
            ;;
        *)
            echo "Unknown filter: $FILTER"
            usage
            ;;
    esac

    if [ "$SHOW" = "true" ]; then
        COUNT=$((COUNT + 1))

        # Calculate age
        AGE_DAYS=$(calc_age "$UPDATED")
        AGE_DISPLAY=$(format_age "$AGE_DAYS")

        # Status color
        case $STATUS in
            open)
                STATUS_COLOR="${YELLOW}●${NC}"
                ;;
            answered)
                STATUS_COLOR="${GREEN}✓${NC}"
                ;;
            deprecated)
                STATUS_COLOR="${RED}✗${NC}"
                ;;
            *)
                STATUS_COLOR="${CYAN}?${NC}"
                ;;
        esac

        # Age warning indicator
        AGE_IND=""
        if [ "$AGE_WARNING" = "true" ]; then
            AGE_IND="${RED}⚠${NC} "
        fi

        # Display
        echo -e "${STATUS_COLOR} ${AGE_IND}${CYAN}$BASENAME${NC} (${AGE_DISPLAY})"
        echo -e "   ${TITLE}"

        # Show tags if present and not empty
        if [ "$TAGS" != "[]" ] && [ -n "$TAGS" ]; then
            echo -e "   Tags: ${BLUE}$TAGS${NC}"
        fi

        echo ""
    fi
done <<< "$QUESTION_FILES"

# Summary
echo -e "${BLUE}────────────────────────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Total: $COUNT question(s)${NC}"
echo ""
