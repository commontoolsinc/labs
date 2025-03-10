#!/bin/bash

set -e

# Check if HONEYCOMB_API_KEY is set
if [ -z "$HONEYCOMB_API_KEY" ]; then
  echo "Error: HONEYCOMB_API_KEY environment variable is not set"
  echo "Please set it with: export HONEYCOMB_API_KEY=your_api_key"
  exit 1
fi

# Check if HONEYCOMB_DATASET is set
if [ -z "$HONEYCOMB_DATASET" ]; then
  echo "Error: HONEYCOMB_DATASET environment variable is not set"
  echo "Please set it with: export HONEYCOMB_DATASET=your_dataset"
  exit 1
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