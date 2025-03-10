#!/bin/bash

set -e

# Check if HONEYCOMB_API_KEY is set
if [ -z "$HONEYCOMB_API_KEY" ]; then
  echo "Error: HONEYCOMB_API_KEY environment variable is not set"
  echo "Please set it with: export HONEYCOMB_API_KEY=your_api_key"
  exit 1
fi

# HONEYCOMB_DATASET is not required anymore
# Honeycomb API can infer the dataset from the API key

# Check Phoenix environment variables
if [ -z "$CTTS_AI_LLM_PHOENIX_URL" ]; then
  echo "Warning: CTTS_AI_LLM_PHOENIX_URL is not set."
  echo "AI spans will not be routed to Phoenix."
  echo "Set it with: export CTTS_AI_LLM_PHOENIX_URL=your_phoenix_url"
fi

if [ -z "$CTTS_AI_LLM_PHOENIX_API_KEY" ]; then
  echo "Warning: CTTS_AI_LLM_PHOENIX_API_KEY is not set."
  echo "AI spans will not be routed to Phoenix."
  echo "Set it with: export CTTS_AI_LLM_PHOENIX_API_KEY=your_api_key"
fi

if [ -z "$CTTS_AI_LLM_PHOENIX_PROJECT" ]; then
  echo "Warning: CTTS_AI_LLM_PHOENIX_PROJECT is not set."
  echo "AI spans will not be routed to Phoenix."
  echo "Set it with: export CTTS_AI_LLM_PHOENIX_PROJECT=your_project"
fi

function start_collector {
  echo "Starting OpenTelemetry collector..."
  docker compose up -d
  echo "Collector started. Listening on ports 4317 (gRPC) and 4318 (HTTP)"
}

function stop_collector {
  echo "Stopping OpenTelemetry collector..."
  docker compose down
  echo "Collector stopped"
}

function show_status {
  docker compose ps
}

function show_logs {
  docker compose logs -f
}

case "$1" in
  start)
    start_collector
    ;;
  stop)
    stop_collector
    ;;
  restart)
    stop_collector
    start_collector
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac

exit 0