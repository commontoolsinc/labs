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

## Worker Model & Isolation

### Process Model

The service uses Web Workers for charm execution, which means:

- Each worker runs in its own JavaScript thread (not OS process)
- Workers have isolated memory spaces and cannot directly access main thread
  memory
- All communication happens through message passing
- State is not shared between workers

### Isolation Guarantees

- Memory Isolation: Each worker has its own JavaScript heap
- Storage Isolation: Each worker initializes its own storage connection
- Error Isolation: Crashes in one worker do not affect others
- Resource Isolation: Each worker manages its own connections and resources

### Operational Characteristics

1. State Management
   - Main thread maintains metadata (worker status, task counts)
   - Workers maintain their own execution state
   - No cross-worker state sharing
   - State persists only for duration of task execution

2. Resource Management
   - Each worker initializes fresh connections
   - Resources are scoped to individual task executions
   - Connections are not pooled across workers
   - Resources are cleaned up after task completion

3. Failure Modes
   - Worker crashes do not affect other workers
   - Failed workers are automatically recycled
   - Long-running workers are forcefully terminated
   - System maintains health checks and statistics

### Limitations

- Not true OS-level process isolation
- Memory limits are shared within the JS runtime
- CPU scheduling depends on JS runtime implementation
- File system access is shared at runtime level

### Improvements

We could have a more sophisticated map of what charms already have documents
loaded in specific workers and try to re-use those.

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
