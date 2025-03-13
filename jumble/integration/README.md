# integration tests:

1. run toolshed on 8000 (default)
2. run jumble on 5173 (with toolshed pointing to 8000)

# Notes on AI iteration

- we store cached llm responses in these integration tests
- this allows running them with an expected response - assuming the request
  hasn't changed
- if the requests need to be changed:
  - delete all the existing toolshed/cache/llm-api-cache
  - run the integration tests
  - copy the (minimal) json blobs to integration/cache/llm-api-cache
  - update any assertions in the run steps
