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

## Available Integrations

The service can be run with various integrations:

- `gmail`: Google Mail integration
- `gcal`: Google Calendar integration (partially implemented)
- anything that exports a bgUpdater and a common-updater component:

```tsx
<common-updater $state={state} integration="rss" />;
```

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
TOOLSHED_API_URL=http://localhost:8000 deno task start
```
