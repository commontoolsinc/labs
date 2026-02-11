#!/usr/bin/env bash
# Sample call that views cell of:...s4ia in space did:key:...Ntos and 
# uses jq to select the property at value.argument:
# $> db_view Ntos s4ia | jq .value.argument
# This should be run from the labs folder (so we can find the sqlite db).
# Use -a to get all the results, instead of just the last.
db_view() {
  local mode="last"
  local space
  local cell

  # Parse arguments
  if [[ "$1" == "--all" || "$1" == "-a" ]]; then
    mode="all"
    space=$2
    cell=$3
  else
    space=$1
    cell=$2
  fi  
  
  if [[ -z "$space" || -z "$cell" ]]; then
    echo "Usage: db_view [--all|-a] <space> <cell>" >&2
    return 1
  fi
  
  local db_file=$(find ./packages/toolshed/cache/memory/ -name "did:key:*$space.sqlite" -print -quit)
  
  if [[ -z "$db_file" ]]; then
    echo "Error: Database file not found for space '$space'" >&2
    return 1
  fi

  local query
  if [[ "$mode" == "last" ]]; then
    query="SELECT datum.source
             FROM datum, memory, fact 
            WHERE memory.of LIKE '%$cell' 
              AND memory.fact = fact.this
              AND fact.\`is\` = datum.this"
  else
    query="SELECT datum.source FROM datum, fact 
            WHERE fact.of LIKE '%$cell' 
              AND fact.\`is\` = datum.this"
  fi

  # use mode=rw so we don't create new db files if there's no match
  sqlite3 "file:$db_file?mode=rw" "$query"
}      

# If script is executed (not sourced), call the function with arguments
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  db_view "$@"
fi