# Toolshed

Toolshed is where we organize all of our backend platform tools that are needed
to run our system.

## Project Overview

### API Endpoints

For a detailed list of endpoints, their documentation, and an interactive API
playground, take a look at the Toolshed API reference playground:
<https://toolshed.commontools.dev/reference>

### Philosophy and Structure

Toolshed is built as a single monolithic [Deno2](https://deno.com/blog/v2.0)
[Hono HTTP API](https://hono.dev/) with the following key principles:

1. **Personal Computing, Not Webscale** - Each user will have their own
   instance, so optimize for individual-user-scale
2. **Minimize Complexity** - Keep implementations and endpoints simple and
   shallow
3. **Product Before Protocol** - Focus on building features that enable
   user-facing use cases
4. **Ship First, Optimize Later** - Use proven technology and iterate quickly

The project follows a structured layout:

```sh
toolshed/
├── lib/          # Shared utilities and configuration
├── middlewares/  # Global hono middleware
├── routes/       # API endpoints
│   ├── ai/       # AI-related services
│   │   └── llm/   # LLM services
│   │   └── img/   # Image generation services
│   │   └── spell/ # Spell casting and other spell related things.
│   │   └── voice/ # Voice transcription services
│   └── health/   # Health checks
├── app.ts        # Main app setup, where we mount all the routes
├── env.ts        # Environment variable configuration
└── index.ts      # Main hono entry point
```

### The LLM provider abstraction

The model catalog, the aliases, the capability records, the provider clients,
and the chain that decides what `default` means are all in
[`routes/ai/llm/models.ts`](routes/ai/llm/models.ts). `@commonfabric/llm` is the
caller's side of that boundary and holds none of it: it names a model and posts
the request here.
[`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
gives the reasoning.

### Gateway request provenance

The LLM gateway attributes its spend by what a caller says about itself, so the
requests toolshed sends it carry the same `x-cf-harness-*` headers and
`User-Agent` that `cf-harness` sends. The headers are built by
`lib/gateway-provenance.ts` from
[`@commonfabric/cf-harness/provenance`](../cf-harness/src/provenance.ts), and
they go on requests to the gateway alone: the other providers in
`routes/ai/llm/models.ts` address a model vendor's own API, which has nothing in
front of it to remove an internal header.

A request reports `service=toolshed`, a principal for the machine, a session for
this toolshed process, and a `command` naming the route it came from —
`generate-text`, `generate-object`, `list-models`, or `web-search`. The access
log records the user agent of every request, so in Cloud Logging:

```text
resource.type="k8s_container"
resource.labels.namespace_name="envoy-gateway-system"
jsonPayload."user-agent"=~"^toolshed "
```

`jsonPayload.caller_command` splits that traffic by route, and
`jsonPayload.caller_session` groups the requests of one toolshed process.

The principal is kept in `$CF_HARNESS_HOME/principal`, or under `HOME` when that
is unset, so a deployment whose filesystem does not survive a restart draws a
new one each time. Setting `CF_HARNESS_PRINCIPAL` pins it to the deployment.

What a value may contain is fixed by the invariants in
[`docs/features/gateway-request-provenance.md`](../../docs/features/gateway-request-provenance.md):
no request content, and nothing that identifies a person. The gateway removes
these headers from the request by name, so a field added here without the
matching change to the gateway manifests reaches the model vendor instead.

## Getting Started

Follow the repository
[development quick start](../../README.md#quick-start-development) to clone the
repository and install the pinned toolchain. Then configure the Toolshed
environment.

### Environment Setup

To set up your environment, you'll need to create a `.env` file in the root of
the toolshed application. You can use the `.env.example` file as a reference.

```shell
cd packages/toolshed
cp .env.example .env
```

The single source of truth for environment variables is the `env.ts` file; it
specifies the types and the defaults for all environment variables in toolshed.

## Development

To run the toolshed development server, you'll want to cd into the toolshed
directory, and then run the following command:

```shell
deno task dev
```

### Running in the background

Passing `--background` starts the server without the caller having to put it in
the background and then wait for it to come up. The command spawns the server as
a child, waits until it has bound its port, and only then returns. Its exit code
reports whether the server started: zero once the server is listening, non-zero
if the server exits before it binds. So a script can start the toolshed and move
straight on to work that needs it, with no readiness poll of its own:

```shell
./toolshed --port=8000 --background --log-file=/tmp/toolshed.log
```

The background server sends its own output to `--log-file` (a temporary file
when the flag is omitted); the command prints that path on success and dumps the
file if the server exits before binding. Readiness travels from the child to the
command over a pipe, so the wait resolves on the event rather than on a poll.
`--background` re-runs the program, so it needs the compiled binary or a
`deno run` launch, not `deno --watch`.

To run the tests:

```shell
deno task test
```

## Editor Setup

The simplest thing to do is open the toolshed directory in vscode/cursor, and
everything should work; as there is configuration in
/toolshed/.vscode/settings.json`.

You'll want to install the
[Deno extension](https://docs.deno.com/runtime/reference/vscode/), and the
[Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Open a pull request
4. If you want a review, ask for a review!
5. Merge!

All code that gets merged into the `main` branch will be immediately deployed to
production.

If you break it, you are responsible for fixing it.
