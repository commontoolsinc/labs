# Toolshed

The Toolshed is a collection of individial HTTP APIs that each perform tasks in
specific domains and areas of interest. The spirit of Toolshed is to make space
for us to quickly design, build, test, and iterate on discrete functionality
within our system.

Practically speaking, Toolshed is a monolith Deno 2 Hono HTTP API scaffolding
where we can quickly prototype new backend HTTP services that power and support
user-facing workflows. Additionally we will utilize Deno KV and Deno Queue to
build a task queue for running background tasks.

The reason we use a monolith is to centralize around a single CI flow, which produces a single binary artifact, which we can sign and distribute for running in several places. For example, this would be able to run locally, in the cloud, in private cloud enclave, or a raspberry pi.

This provides an easy path for building a feature complete API that's easy to distribute, sign, and run in our confidential compute environments.

## Philosophy

We are a tiny crew. We don't have the luxury of time and resources, we need to quickly stub out new functionality in the service of creating a product that people love.

Due to our constraints of needing to run inside of a secure private cloud enclave, and our need for remote attestation, we should lean-in to a few clarifying principals.

### Personal computing, not webscale computing

Each user will have their own instance of Toolshed.

That means we don't need to worry about web-scale tradeoffs. (ie scaling a task queue to >100k messages per second)

Instead, we can optimize for individual-user-scale. (ie scaling a task queue to < 100 messages per second)

### Minimize complexity

**Essential complexity** is inevitable, it is the essence of the problem you're trying to solve. **Accidental complexity** is what creeps in from all of the tech debt and decisions we make.

When introducing a new API endpoint to the Toolshed, try to encapsulate the minimum essential complexity into a simple easy to grok interface.

Avoid accidential complexity by keeping the implementation simple and shallow. By simple and shallow, I mean the implementation is better DAMP (descriptive and meaningful phrases) not DRY (don't repeat yourself).

Don't be afraid to duplicate code, especially if it frees you from tracking yet-another-dependency.

Practically speaking, I think this mostly means that shared code should be general purpose utility code (reading cookies, dealing with auth, accessing a data store, etc); but avoid importing code from other endpoints/services. Instead, just use HTTP to use the other services.

### Product before protocol

At our stage, the most important thing is that we build a product that people
love.

Stay flexible with how things interact and talk to eachother, but don't make
rigid permanent decisions that are difficult to change. We aren't ready to
commit to set-in-stone protocols while we're still exploring the product-fit.

Focus on delivering discrete functionality that that helps us unsderstand or
support a user-facing usecase.

### Ship first, optimize later

Because we are optimizing for personal computing scale, and focused on the
product look/feel, focus on SHIPPING.

Don't be clever. Use boring off-the-shelf technology. Don't worry about
optimizing for performance.

Just ship it.

## Design

The idea here is that we have a single root API, which only handles ROUTING and
LOGGING. Then each individual API will register and mount itself and a distinct
URL endpoint.

The URL root prefix is `/api`

For example, here are some potential endpoints we may want:

- `/api/profile` (queryable user profile knowledge graph)
- `/api/ai/llm` (planning server)
- `/api/ai/img` (flux)
- `/api/ai/url2text` (jina reader)
- `/api/ai/transcribe` (incredibly fast whisper)
- `/api/data` (synopsys db proxy)

In the future, it's possible we will want to refactor or completely rewrite an
individual endpoint, for example, the `/ai/llm` endpoint could require breaking
changes to improve. During such a rewrite, if you are breaking the interface,
you should add an additional version path to the URL.

`/api/profile/v2/`

This allows us to aggressively pursue new breaking ideas, while also supporting
old still-functional API endpoints.

## Structure

```sh
toolshed/
├── lib/
│   ├── configure-open-api.ts  # OpenAPI configuration
│   ├── constants.ts           # Global constants
│   ├── create-app.ts          # App factory
│   └── types.ts               # Common types
├── middlewares/
│   └── pino-logger.ts         # Logging middleware
├── routes/
│   ├── ai/                    # AI-related endpoints
│   │   └── img/              # Image generation
│   │       ├── img.handlers.ts    # Request handlers
│   │       ├── img.index.ts       # Route definitions
│   │       ├── img.routes.ts      # Route schemas
│   │       └── img.test.ts        # Test cases
│   │   └── llm/              # Language model endpoints
│   │       ├── cache.ts      # llm-specific caching
│   │       ├── llm.handlers.ts    # Request handlers
│   │       ├── llm.index.ts       # Route definitions
│   │       ├── llm.routes.ts      # Route schemas
│   │       ├── llm.test.ts        # Test cases
│   │       └── models.ts          # Model definitions
│   └── health/               # Health check endpoint
│       ├── health.handlers.ts
│       ├── health.index.ts
│       ├── health.routes.ts
│       └── health.test.ts
├── app.ts                    # Main app setup
├── env.ts                    # Environment config
└── index.ts                  # Entry point
```

## Deployment

We still have some unknowns around how, exactly, we want to deploy things into
secure enclaves. This is a very handwavy collection of thoughts.

One such option that's been talked about a lot is using kubernetes in
conjunction with [Constellation from
Edgeless](https://docs.edgeless.systems/constellation). The big downside with
Constellation, is that we need to actually run our own kubernetes controlplane,
we can't rely on AKS/EKS/GKE. This makes it significantly less attractive to me
from a daily operations perspective, as it adds a large amount of complextiy and
operational upkeep.

Instead, I think we would be more well suited if we had some sort of custom
controlplane that manages quickly spinning up, and monitoring instances of
Toolshed. What I mean by this is we can build Toolshed, sign it, then create a
bare cloud VM image that contains little more than the toolshed binary. When a
new user signs up, and we need to spin up their sandbox/vm, we can schedule the
creation of a cloud instance using the latest VM image. When the vm image comes
online, it will have everything it needs to support and expose remote
attestation. This setup also gives us a straightforward path to exposing metrics
from a VM to the cloud orchestrator. Since we can't see inside the vm, we will
want to expose some metrics export capability so the orchestrator understands
"is the toolshed running?", "is the toolshed performing?", all without ever
having to peek inside or see user data.

This is sort of an unclear brain dump as I rush to get this out of my brain, but
it's clear to me that this general direction will give us operational clarity
and the ability to quickly iterate and improve our infrastructure.

Kubernetes is a charismatic trap.
