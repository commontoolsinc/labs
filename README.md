# Common Labs

Radioactive experiments. Turn back! You will find no API stability here.

![A loom, by Midjourney](./docs/images/loom.jpg)

## Overview

There's a frontend, and a backend.

All of the backend code lives within [Toolshed](./toolshed), and is written in
Deno2.

All of the frontend code lives within various packages, inside of `./`.

## Running the backend

For a more detailed guide, see [./toolshed/README.md](./toolshed/README.md).

```bash
cd ./toolshed
deno task dev
```

By default the backend will run at http://localhost:8000

## Running the frontend

For a more detailed guide, see the pnpm monorepo readme
[./README.md](./README.md).

Run the dev server

```bash
cd ./jumble
deno task dev
```

By default, the frontend will run at http://localhost:5173, and it will point to
a local backend running at http://localhost:8000.

If you are not actively making updates to the backend, you can also point to the
backend running in the cloud, by running the following command:

```shell
TOOLSHED_API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```
