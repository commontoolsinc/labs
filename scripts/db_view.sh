#!/usr/bin/env bash
# Sample call that views cell of:...s4ia in space did:key:...Ntos and 
# uses jq to select the property at value.argument:
# $> db_view Ntos s4ia | jq .value.argument
# This should be run from the labs folder (so we can find the sqlite db).
# This returns all the results in the database, not just the last.
db_view() {
  local space=$1
  local cell=$2
  
  if [[ -z "$space" || -z "$cell" ]]; then
    echo "Usage: db_view <space> <cell>" >&2
    return 1
  fi
  
  local db_file=$(find ./packages/toolshed/cache/memory/ -name "did:key:*$space.sqlite" -print -quit)
  
  if [[ -z "$db_file" ]]; then
    echo "Error: Database file not found for space '$space'" >&2
    return 1
  fi
  
  sqlite3 "file:$db_file?mode=rw" \
    "SELECT datum.source 
     FROM datum, fact 
     WHERE fact.of LIKE '%$cell' 
       AND fact.\`is\` = datum.this"
}

# If script is executed (not sourced), call the function with arguments
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  db_view "$@"
fi