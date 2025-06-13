# Charm Seeder

"42 charms" project runs a collection of workflows/prompts to create and verify
charms.

## Setup requirements

1. get an openai api key from <https://platform.openai.com/api-keys>
2. set it in your environment / toolshed

   export OPENAI_API_KEY=sk-proj-...

## Running the seeder

You can run the seeder on your local branch

local:

You will need to run the toolshed and jumble in other tabs, you will want to
have an `.env` file for toolshed with keys for LLMs and API/project setup for
phoenix.

    cd toolshed; deno task dev
    cd jumble; deno task dev-local

    TOOLSHED_API_URL=http://localhost:8000 deno task start --name blue42

staging:

    TOOLSHED_API_URL=https://toolshed.saga-castor.ts.net deno task start --name blue42

estuary:

    TOOLSHED_API_URL=https://estuary.saga-castor.ts.net deno task start --name blue42

To run the seeder with a specific tag, use the `--tag` flag.

    deno task start --name blue42 --tag smol

To run the seeder with cache disabled, use the `--no-cache` flag.

    deno task start --name blue42 --no-cache

## Adding more scenarios / prompts

You can add new flows to `scenarios.ts`.

## Reading the report

A report will be generated in the `results` directory named
`results/blue42.html`. You can open this in your browser to see the results.
