#\!/bin/bash

# Page Manager Helper Script
# Usage: ./page-manager-helper.sh [command] [args...]

CONFIG_FILE=".page-agent-config.json"
RECIPE_PATH="/Users/ben/code/recipes/recipes/coralreef/page.tsx"
SPACE="2025-07-28-berni"
IDENTITY="claude.key"
API_URL="https://toolshed.saga-castor.ts.net/"
WORK_NOTES_CHARM="baedreiadodmnlokromhwaotm3tfmjkv4xpbqwtopr74zbp3g54mxp5wmby"

case "$1" in
    "get-title")
        ./dist/ct charm get --identity $IDENTITY --api-url $API_URL --space $SPACE --charm $WORK_NOTES_CHARM title
        ;;
    "get-outline")
        ./dist/ct charm get --identity $IDENTITY --api-url $API_URL --space $SPACE --charm $WORK_NOTES_CHARM outline
        ;;
    "get-tags")
        ./dist/ct charm get --identity $IDENTITY --api-url $API_URL --space $SPACE --charm $WORK_NOTES_CHARM tags
        ;;
    "add-task")
        if [ -z "$2" ]; then
            echo "Usage: $0 add-task 'task description'"
            exit 1
        fi
        echo "Add task functionality would be implemented here for: $2"
        ;;
    "list-charms")
        ./dist/ct charm ls --identity $IDENTITY --api-url $API_URL --space $SPACE
        ;;
    "inspect")
        ./dist/ct charm inspect --identity $IDENTITY --api-url $API_URL --space $SPACE --charm $WORK_NOTES_CHARM
        ;;
    *)
        echo "Available commands:"
        echo "  get-title    - Get the page title"
        echo "  get-outline  - Get the page outline structure"
        echo "  get-tags     - Get the page tags"
        echo "  list-charms  - List all charms in the space"
        echo "  inspect      - Inspect the work notes charm"
        echo ""
        echo "Configuration:"
        echo "  Space: $SPACE"
        echo "  Work Notes Charm: $WORK_NOTES_CHARM"
        ;;
esac
