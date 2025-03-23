# Background Charm Service

A service for running background charms with integration capabilities.

## Overview

The Background Charm Service runs charms in the background with:

- In-memory job queue with concurrency control
- Worker pooling for isolated charm execution
- Automatic error handling and cleanup
- Simple integration model
- Lightweight monitoring

## Architecture

Core Components

1. **BackgroundCharmService** (service.ts)
   - Main orchestrator that coordinates all components
   - Manages service lifecycle and charm execution
   - Uses simple in-memory state tracking

2. **JobQueue** (job-queue.ts)
   - Straightforward in-memory queue with priority
   - Manages job concurrency and timeouts
   - Provides continuous job processing

3. **ExecuteCharmHandler** (execute-charm-handler.ts)
   - Handles charm execution via worker pool
   - Manages charm execution lifecycles

Worker System

4. **WorkerPool** (utils/worker-pool.ts)
   - Manages isolated worker processes
   - Handles worker lifecycle and task distribution
   - Recycles workers based on health criteria

5. **CharmWorker** (utils/charm-worker.ts)
   - Isolated execution environment for charms
   - Reports results back to the main thread

6. **RunCharm** (utils/run-charm.ts)
   - Core utility for executing charms
   - Creates sessions and triggers updater streams

## Worker Model & Isolation

### Process Model

The service uses Web Workers for charm execution, which means:

- Each worker runs in its own JavaScript thread (not OS process)
- Workers have isolated memory spaces and cannot directly access main thread memory
- All communication happens through message passing
- State is not shared between workers

### Isolation Guarantees

- Memory Isolation: Each worker has its own JavaScript heap
- Error Isolation: Crashes in one worker do not affect others
- Resource Isolation: Each worker manages its own connections and resources

### Operational Characteristics

1. State Management
   - Main thread uses simple in-memory tracking for worker status
   - Workers maintain their own execution state
   - No cross-worker state sharing

2. Resource Management
   - Each worker initializes fresh connections
   - Resources are scoped to individual task executions
   - Workers are recycled after reaching lifetime or task limits

3. Failure Modes
   - Worker crashes do not affect other workers
   - Failed workers are automatically recycled
   - Long-running workers are forcefully terminated

### Limitations

- Not true OS-level process isolation
- Memory limits are shared within the JS runtime
- CPU scheduling depends on JS runtime implementation
- File system access is shared at runtime level

### Potential Improvements

- Implement intelligent worker routing based on charm needs
- Add metrics collection for performance analysis
- Introduce more sophisticated error recovery strategies
- Optimize worker recycling based on memory usage patterns

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