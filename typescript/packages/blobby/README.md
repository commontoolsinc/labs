# Blobby

Blobby is a simple blob storage service where we can store and share recipes with commoners on tailscale.

It is a [hono](https://hono.dev/) rest API written in typescript using [deno 2.x](https://deno.com/).

## Dependencies

To run blobby, you will need to have [redis](https://redis.io/) installed and running locally. On macOS, you can use [brew](https://brew.sh/) to install it:

```bash
brew install redis
brew services start redis
```

Beyond that, you don't actually need to setup a `.env` file unless you want to use non-default ports or redis urls. To get blobby running locally, you can optionally setup a `.env` file based on the `.env-example` file to set a port. To do this, simply copy the `.env-example` file to `.env` and update your values.

```bash
cp .env-example .env
```

## Running locally

No need to npm install anything, just run the following commands, and deno will take care of the rest.

```bash
# runs with --watch, so changes to code restart the server
deno task dev
```

```bash
# runs without --watch, so changes to code don't restart the server. This is more suitable for running in production.
deno task start
```

## Running tests

There aren't any unit tests at this time, but there is a little `upload-test.ts` script that you can use to exercise the blobby service; by uploading blobs and then retrieving them.

```bash
deno task upload-test
```

If you want to run against a remote server, you can set the `BASE_URL` environment variable to the url of the server you want to test against.

```bash
BASE_URL=https://paas.saga-castor.ts.net/blobby deno task upload-test
```

## Using the Blobby HTTP API

The blobby service supports a few different endpoints for interacting with the blob storage. For these examples, we'll use the production server url as the base url, but you could swap-in `http://localhost:3000` if you wanted to test against a local server.

#### List ALL blobs

```bash
curl https://paas.saga-castor.ts.net/blobby/blobs?all=true
```

#### List your user's blobs

```bash
curl https://paas.saga-castor.ts.net/blobby/blobs
```

#### Store a blob

```bash
curl -X POST https://paas.saga-castor.ts.net/blobby/blob/[hash] \
  -H "Content-Type: text/plain" \
  -d '{"superhappyobjects": {"wibble": "wobble", "foo": "bar"}}'
```

#### Get a blob

```bash
curl https://paas.saga-castor.ts.net/blobby/blob/[hash]
```

#### Get a PNG screenshot of a blob

```bash
curl https://paas.saga-castor.ts.net/blobby/blob/[hash]/png
```

#### Query JSON blob contents

The API supports querying nested JSON values using path segments. For example, given a blob with content:

```json
{
  "superhappyobjects": {
    "wibble": "wobble",
    "foo": "bar"
  }
}
```

Get a nested object:

```bash
curl https://paas.saga-castor.ts.net/blobby/blob/[hash]/superhappyobjects
# Returns: {"wibble": "wobble", "foo": "bar"}
```

Get a specific value:

```bash
curl https://paas.saga-castor.ts.net/blobby/blob/[hash]/superhappyobjects/foo
# Returns: bar
```

### Authentication

All endpoints require Tailscale authentication by default. The service expects a `Tailscale-User-Login` header to be present in the request. This is handled transparently when accessing the service through Tailscale.
