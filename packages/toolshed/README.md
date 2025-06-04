# Toolshed

Toolshed is where we organize all of our backend platform tools that are needed to run our system.

## Project Overview

### API Endpoints

For a detailed list of endpoints, their documentation, and an interactive API playground, take a look at the Toolshed API reference playground: https://toolshed.commontools.dev/reference

### Philosophy and Structure

Toolshed is built as a single monolithic [Deno2](https://deno.com/blog/v2.0) [Hono HTTP API](https://hono.dev/) with the following key principles:

1. **Personal Computing, Not Webscale** - Each user will have their own instance, so optimize for individual-user-scale
2. **Minimize Complexity** - Keep implementations and endpoints simple and shallow
3. **Product Before Protocol** - Focus on building features that enable user-facing use cases
4. **Ship First, Optimize Later** - Use proven technology and iterate quickly

The project follows a structured layout:

```
toolshed/
├── lib/          # Shared utilities and configuration
├── middlewares/  # Global hono middleware
├── routes/       # API endpoints
│   ├── ai/       # AI-related services
│   │   └── llm/   # LLM services
│   │   └── img/   # Image generation services
│   │   └── webreader/ # Web reader services
│   │   └── spell/ # Spell casting and other spell related things.
│   │   └── voice/ # Voice transcription services
│   └── health/   # Health checks
├── app.ts        # Main app setup, where we mount all the routes
├── env.ts        # Environment variable configuration
└── index.ts      # Main hono entry point
```

## Getting Started

To get started, you'll need to clone the git repository, install a few dependencies, and set up your environment variables.

To clone the repository, you can run the following command:

```
git clone git@github.com:commontoolsinc/labs.git
cd labs/toolshed
```

### Prerequisites

#### Deno

Toolshed is build using Deno, so you'll need to install Deno if you want to run the code locally. Deno has a detailed installation guide [here](https://deno.land/manual/getting_started/installation).

The fastest path to install on MacOS and Linux is to run the following command:

```shell
curl -fsSL https://deno.land/install.sh | sh
```

#### Redis

The blobby service uses [Redis](https://redis.io/), so you'll need to install Redis locally.

On MacOS, you can install and run Redis using Homebrew:

```shell
brew install redis
brew services start redis
```

For detailed instructions on other platforms, please refer to the [Redis installation guide](https://redis.io/docs/latest/install/).

#### Environment Setup

To setup your environment, you'll need to create a `.env` file in the root of the toolshed application. You can use the `.env.example` file as a reference.

```shell
cp .env.example .env
```

The single source of truth for environment variables is the `env.ts` file; it specifies the types and the defaults for all environment variables in toolshed.

## Development

To run the toolshed development server, you'll want to cd into the toolshed directory, and then run the following command:

```shell
deno task dev
```

To run the tests:

```shell
deno task test
```

## Editor Setup

The simplest thing to do is open the toolshed directory in vscode/cursor, and everything should work; as there is configuration in /toolshed/.vscode/settings.json`.

You'll want to install the [Deno extension](https://docs.deno.com/runtime/reference/vscode/), and the [Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode).

## CI/CD

Our CI/CD pipeline is basically: run a linter, run the tests, deploy to fly.

It's built on GitHub Actions, the configuration [lives here](https://github.com/commontoolsinc/labs/blob/main/.github/workflows/toolshed.yml).

## Deploying to Production

Toolshed is deployed to fly.io.

To deploy you simply run the following command:

```shell
fly deploy
```

If you need access to deploy to fly, ping Jake for access and instructions.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Open a pull request
4. If you want a review, ask for a review!
5. Merge!

All code that gets merged into the `main` branch will be immediately deployed to production.

If you break it, you are responsible for fixing it.
