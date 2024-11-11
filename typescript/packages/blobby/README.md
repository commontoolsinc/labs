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
