# Background Charm Service

A robust service for running background charms with integration capabilities and
health monitoring.

## Overview

The Background Charm Service runs charms in the background with:

- Persistent job queue using Deno KV
- Worker pooling for efficient charm execution
- Automatic error handling and retry logic
- Integration with external services (Gmail, GCal, etc.)
- Comprehensive logging and monitoring

## Architecture

Core Components

1. BackgroundCharmService (service.ts) - Main orchestrator that coordinates all
   components - Manages service lifecycle and schedules charm execution - Uses
   Deno KV for persistence
2. StateManager (state-manager.ts) - Tracks service and charm state in Deno KV -
   Manages execution statistics and error tracking - Handles disabling charms
   after failures
3. JobQueue (job-queue.ts) - Priority-based queue for scheduling work - Manages
   job status, retries, and concurrency limits
4. Job Handlers - BaseHandler: Common interface for all handlers -
   ExecuteCharmHandler: Executes charms via worker pool - MaintenanceHandler:
   Performs system maintenance tasks

Worker System

5. WorkerPool (utils/worker-pool.ts) - Manages isolated worker processes -
   Handles worker lifecycle and task distribution - Provides fault tolerance
6. CharmWorker (utils/charm-worker.ts) - Isolated execution environment for
   charms - Reports results back to the main thread
7. RunCharm (utils/run-charm.ts) - Core utility for executing charms - Creates
   sessions and triggers updater streams

### Charm Integration

```tsx
<common-updater $state={state} integration="rss" />;
```

then expose a bound `bgUpdater` handler in your result

## Development

### Prerequisites

- Deno 2.2 or later

### Running the Service

There are two main commands for running the service:

1. Add admin charm:

```
TOOLSHED_API_URL=http://localhost:8000 deno task add-admin-charm
```

2. Start the service:

```
TOOLSHED_API_URL=http://localhost:8000 MEMORY_URL=http://localhost:8000 deno task start
```
