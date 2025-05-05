# integration tests:

1. run toolshed on 8000 (default) - in toolshed: `deno task dev`
2. run jumble on 5173 (with toolshed pointing to 8000) - in jumble:
   `deno task dev-local`

# Notes on AI iteration

- we store cached llm responses in these integration tests
- this allows running them with an expected response - assuming the request
  hasn't changed

- to regenerate the LLM cache, run `chmod u+x rebuild-llm-cache.sh` and then
  `./rebuild-llm-cache.sh`, this will:
  - delete the existing `toolshed/cache/llm-api-cache`
  - run `toolshed` and `jumble` pointing to local dev environment
    - relies on local LLM config
  - run the integration tests
  - copy the (minimal) json blobs to `integration/cache/llm-api-cache`
