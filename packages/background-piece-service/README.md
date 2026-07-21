# Background Piece Service

A service for running background pieces with isolation and monitoring
capabilities.

**FIXME(ja): all of this is built on a lie: If update method is async (uses
fetch - like gmail) the handler will "finish" while work is still happening!
Because many updaters are async we don't receive exceptions (mark them as
failing) or know when to properly reschedule them.**

## Overview

> **Polling-Based Architecture**
>
> This service is polling-based, not event-driven:
>
> - Polls registered pieces every ~60 seconds (hardcoded in `space-manager.ts`)
> - `bgUpdater` handlers do not automatically trigger when captured cells change
> - On each poll, sends `{}` to the piece's `bgUpdater` Stream
> - For real-time updates, use browser-triggered handlers instead

The Background Piece Service runs pieces in the background with:

- Space-based isolation for piece execution (one web worker per space)
- Isolated execution in web workers to prevent interference
- Automatic piece scheduling and execution based on defined intervals
- Error handling and status tracking for reliable operation
- Simple monitoring and management of background processes

## Architecture

### Core Components

1. **BackgroundPieceService** (service.ts)
   - Main orchestrator that coordinates all components
   - Manages service lifecycle and piece discovery
   - Creates and manages SpaceManagers for each space

2. **SpaceManager** (space-manager.ts)
   - Manages pieces for a specific space
   - Schedules and tracks piece execution
   - Maintains piece status (enabled/disabled, last run time, errors)
   - Communicates with a dedicated WorkerController

3. **WorkerController** (worker-controller.ts)
   - Manages communication with the Worker
   - Handles message passing and timeout tracking
   - Provides interface for piece execution

4. **Worker** (worker.ts)
   - Runs in an isolated thread
   - Sets up a session for a specific space
   - Handles piece loading and execution
   - Reports results back to the WorkerController

### Execution Flow

1. The service discovers background pieces from the central toolshed-system list
   of pieces
2. For each unique space, a SpaceManager is created
3. Each SpaceManager creates its own WorkerController with an isolated worker
4. The SpaceManager schedules and executes pieces through its WorkerController
5. The worker runs each piece and reports results back
6. The SpaceManager tracks status and schedules re-runs based on results

## Isolation Model

The service provides isolation at multiple levels:

- **Space Isolation**: Each space gets its own SpaceManager and Worker
- **Worker Isolation**: Each WorkerController uses a Web Worker for thread-level
  isolation
- **Session Isolation**: Each worker has its own session with proper permissions
- **Error Isolation**: Errors in one piece do not affect other pieces or spaces

This model enables:

- Running pieces from different spaces without interference
- Protecting against crashes and resource exhaustion
- Ensuring proper permission boundaries between spaces
- Providing detailed status tracking per piece

## Development

### Prerequisites

- Deno 2.2 or later

### Running the Service

Start the service:

```sh
COMMIT_SHA=<labs-revision> \
  API_URL=http://localhost:8000 \
  OPERATOR_PASS=your-passphrase \
  deno task start
```

### Environment Variables

- `API_URL`: URL to the toolshed API (default: `http://localhost:8000`)
- `OPERATOR_PASS`: Passphrase for the operator identity (default:
  `implicit trust`)
- `IDENTITY`: (Optional) Path to an identity keyfile
- `COMMIT_SHA`: (Optional) Labs revision passed to worker runtimes for the
  system-pattern update version gate. It must match the target toolshed's
  reported revision.

### Monitoring

The service provides status information for each space and piece:

- Enabled/disabled status
- Last execution time
- Last success/failure
- Error information for failed pieces

## Piece Integration

To create a background piece:

1. Create a piece with a `bgUpdater` stream handler
2. Use the common-updater component to register for background updates
