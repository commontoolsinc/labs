# OpenTelemetry Collector for Memory Service & AI Observability

This directory contains configuration for an OpenTelemetry collector that:
1. Implements sampling for memory.* metrics to reduce the volume of spans sent to Honeycomb
2. Routes AI/LLM-related spans to Phoenix for LLM observability

## Configuration

The OpenTelemetry collector is configured to:

- Receive OTLP data via both gRPC (port 4317) and HTTP (port 4318)
- Sample memory.* traces at 5% (only sending 1 out of every 20 traces) to Honeycomb
- Route all AI-related spans to Phoenix
- Use separate pipelines for memory and AI telemetry

## Usage

### Prerequisites

- Docker and Docker Compose
- Honeycomb API key
- Phoenix API key (for AI/LLM spans)

### Running the collector

1. Set up environment variables:

```sh
# Honeycomb credentials (required)
export HONEYCOMB_API_KEY=your_api_key
# Dataset is inferred from your API key

# Phoenix credentials (for AI/LLM observability)
export CTTS_AI_LLM_PHOENIX_URL=your_phoenix_url
export CTTS_AI_LLM_PHOENIX_API_KEY=your_api_key
export CTTS_AI_LLM_PHOENIX_PROJECT=your_project
```

2. Start the collector:

```sh
cd otel-collector
./collector.sh start
```

3. Configure your application to send traces to the collector:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

## Customizing Sampling

To adjust the sampling rate, modify the `sampling_percentage` value in the `otel-collector-config.yaml` file:

- For memory traces: Set to 5% sampling with `probabilistic_sampler` after filtering with `filter/memory_only`

Lower percentages will reduce the number of spans sent to Honeycomb.

## Telemetry Routing

The collector uses filters to route data:

- **Memory spans**: Go to Honeycomb with sampling (and to debug logging)
- **AI/LLM spans**: Go to Phoenix without sampling (and to debug logging)

This ensures your LLM observability is complete while managing data volume for regular traces.

## Span Filtering Configuration

AI/LLM spans are identified using these patterns:
- Service name matching `ai.*`
- Span names containing: `llm`, `ai`, `prompt`, `completion`, or `embedding`

To adjust this filtering, modify the `filter/ai` and `filter/not_ai` processors in the config file.