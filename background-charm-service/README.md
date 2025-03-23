# Background Charm Service

A service for running background charms with isolation and monitoring
capabilities.

**FIXME(ja): all of this is built on a lie: If update method is async (uses
fetch - like gmail) the handler will "finish" while work is still happening!
Because many updaters are async we don't receive exceptions (mark them as
failing) or know when to properly reschedule them.**

## Overview

The Background Charm Service runs charms in the background with:

- Space-based isolation for charm execution
- Habitat workers for isolated charm environments
- Automatic charm scheduling and execution
- Error handling and status tracking
- Simple monitoring and management

## Architecture

### Core Components

1. **BackgroundCharmService** (service.ts)
   - Main orchestrator that coordinates all components
   - Manages service lifecycle and charm discovery
   - Creates and manages SpaceStations for each space

2. **SpaceStation** (space-station.ts)
   - Manages charms for a specific space
   - Schedules and tracks charm execution
   - Maintains charm status (enabled/disabled, last run time, errors)
   - Communicates with a dedicated Habitat

3. **Habitat** (habitat.ts)
   - Isolated execution environment for a space
   - Manages worker lifecycle and communication
   - Provides a safe execution environment for charms

4. **Worker** (worker.ts)
   - Runs in an isolated thread
   - Sets up a session for a specific space
   - Handles charm loading and execution
   - Reports results back to the Habitat

### Execution Flow

1. The service discovers background charms from the central toolshed-system list
   of charms
2. For each unique space, a SpaceStation is created
3. Each SpaceStation creates its own Habitat with an isolated worker
4. The SpaceStation schedules and executes charms through its Habitat
5. The worker runs each charm and reports results back
6. The SpaceStation tracks status and schedules re-runs based on results

## Isolation Model

The service provides isolation at multiple levels:

- **Space Isolation**: Each space gets its own SpaceStation and Habitat
- **Worker Isolation**: Each Habitat uses a Web Worker for thread-level
  isolation
- **Session Isolation**: Each worker has its own session with proper permissions
- **Error Isolation**: Errors in one charm do not affect other charms or spaces

This model enables:

- Running charms from different spaces without interference
- Protecting against crashes and resource exhaustion
- Ensuring proper permission boundaries between spaces
- Providing detailed status tracking per charm

## Development

### Prerequisites

- Deno 2.2 or later

### Running the Service

Start the service:

```
TOOLSHED_API_URL=http://localhost:8000 OPERATOR_PASS=your-passphrase deno task start
```

### Environment Variables

- `TOOLSHED_API_URL`: URL to the toolshed API
- `OPERATOR_PASS`: Passphrase for the operator identity
- `POLLING_INTERVAL_MS`: (Optional) Interval for job queue polling
- `MAX_CONCURRENT_JOBS`: (Optional) Maximum concurrent jobs per space

### Monitoring

The service provides status information for each space and charm:

- Enabled/disabled status
- Last execution time
- Last success/failure
- Error information for failed charms

## Charm Integration

To create a background charm:

1. Create a charm with a `bgUpdater` stream handler
2. Use the common-updater component to register for background updates
