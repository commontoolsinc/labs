# OpenTelemetry Collector for Memory Service

This directory contains configuration for an OpenTelemetry collector that implements sampling
for the memory.* metrics to reduce the volume of spans sent to Honeycomb.

## Configuration

The OpenTelemetry collector is configured to:

- Receive OTLP data via both gRPC (port 4317) and HTTP (port 4318)
- Sample memory.* traces at 5% (only sending 1 out of every 20 traces)
- Export the sampled traces to Honeycomb

## Usage

### Prerequisites

- Docker and Docker Compose
- Honeycomb API key

### Running the collector

1. Set up environment variables:

```sh
export HONEYCOMB_API_KEY=your_api_key
export HONEYCOMB_DATASET=your_dataset
```

2. Start the collector:

```sh
cd otel-collector
docker compose up -d
```

3. Configure your application to send traces to the collector:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

## Customizing Sampling

To adjust the sampling rate, modify the `sampling_percentage` value in the `otel-collector-config.yaml` file:

- For memory service: Currently set to 10% for attribute-based sampling
- For memory.* pattern matching: Currently set to 5% for string attribute matching

Lower percentages will reduce the number of spans sent to Honeycomb.