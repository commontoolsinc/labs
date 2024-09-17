#!/bin/bash

# Test script for Collectathon Web API

BASE_URL="http://localhost:8000"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}[SUCCESS]${NC} $2"
    else
        echo -e "${RED}[FAILED]${NC} $2"
    fi
}

# Test collections
echo "Testing Collections API..."

# List collections
curl -s "$BASE_URL/collections" | grep "Collections listed in console"
print_result $? "List collections"

# Create a test collection
curl -s -X POST "$BASE_URL/collections/test_collection"
print_result $? "Create test collection"

# Move collection
curl -s -X PUT "$BASE_URL/collections/test_collection/move" -H "Content-Type: application/json" -d '{"newName":"moved_test_collection"}'
print_result $? "Move collection"

# Apply rules to collection
curl -s -X POST "$BASE_URL/collections/moved_test_collection/apply-rules"
print_result $? "Apply rules to collection"

# Test items
echo -e "\nTesting Items API..."

# Create a new item
NEW_ITEM_ID=$(curl -s -X POST "$BASE_URL/items" -H "Content-Type: application/json" -d '{"content":{"title":"Test Item","body":"This is a test item"},"collections":["moved_test_collection"]}' | jq -r '.itemId')
print_result $? "Create new item"

# List items in collection
curl -s "$BASE_URL/collections/moved_test_collection/items" | grep "Items listed for collection moved_test_collection in console"
print_result $? "List items in collection"

# Get item details
curl -s "$BASE_URL/items/$NEW_ITEM_ID" | grep "Item $NEW_ITEM_ID printed in console"
print_result $? "Get item details"

# Update item
curl -s -X PUT "$BASE_URL/items/$NEW_ITEM_ID" -H "Content-Type: application/json" -d '{"content":{"title":"Updated Test Item","body":"This item has been updated"},"raw":false}'
print_result $? "Update item"

# Remove item from collection
curl -s -X DELETE "$BASE_URL/items/$NEW_ITEM_ID/collections/moved_test_collection"
print_result $? "Remove item from collection"

# Add item to collection
curl -s -X POST "$BASE_URL/items/$NEW_ITEM_ID/collections/moved_test_collection"
print_result $? "Add item to collection"

# Test rules
echo -e "\nTesting Rules API..."

# Add rule
curl -s -X POST "$BASE_URL/rules" -H "Content-Type: application/json" -d '{"collection":"moved_test_collection","rule":"title contains Test","targetCollection":"test_target_collection"}'
print_result $? "Add rule"

# List rules
curl -s "$BASE_URL/collections/moved_test_collection/rules" | grep "Rules listed for collection moved_test_collection in console"
print_result $? "List rules"

# Test search
echo -e "\nTesting Search API..."

# Perform search
curl -s "$BASE_URL/search?q=test" | grep "Search results printed in console"
print_result $? "Perform search"

# Test action
echo -e "\nTesting Action API..."

# Perform action on collection
curl -s -X POST "$BASE_URL/collections/moved_test_collection/action" -H "Content-Type: application/json" -d '{"prompt":"Summarize the items"}'
print_result $? "Perform action on collection"

# Test dream
echo -e "\nTesting Dream API..."

# Generate dream for collection
curl -s -X POST "$BASE_URL/collections/moved_test_collection/dream"
print_result $? "Generate dream for collection"

# Test view
echo -e "\nTesting View API..."

# Generate view for collection
VIEW_ID=$(curl -s -X POST "$BASE_URL/collections/moved_test_collection/view" -H "Content-Type: application/json" -d '{"prompt":"Create a table view"}' | jq -r '.viewId')
print_result $? "Generate view for collection"

# Update view for collection
curl -s -X PUT "$BASE_URL/collections/moved_test_collection/view/$VIEW_ID" -H "Content-Type: application/json" -d '{"prompt":"Update the table view with a new column"}'
print_result $? "Update view for collection"

# Clean up
echo -e "\nCleaning up..."

# Delete item
curl -s -X DELETE "$BASE_URL/items/$NEW_ITEM_ID"
print_result $? "Delete item"

# Delete collection
curl -s -X DELETE "$BASE_URL/collections/moved_test_collection"
print_result $? "Delete collection"

echo -e "\nTest script completed."
