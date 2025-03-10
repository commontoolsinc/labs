#!/bin/bash

# the space should be the first argument
space=$1

# the interval should be the second argument
interval=$2

# if no interval is provided, use 10
if [ -z "$interval" ]; then
  interval=10
fi

# if no space is provided, exit
if [ -z "$space" ]; then
  echo "No space provided"
  exit 1
fi

# run the task, if it fails, wait for 10 seconds and try again  
while true; do
  deno task google-importer --space $space --interval $interval
  sleep $interval
done
