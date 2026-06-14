---
name: isolated-test-processes
description: Guide for writing side-effect-free tests that spawn child processes, especially Deno commands. Use when adding or reviewing tests that call Deno.Command, run deno check/test/run/task/install, generate temporary deno.json files, update goldens, write build artifacts, or otherwise risk changing deno.lock or files in the repository workspace.
---

# Isolated Test Processes

Tests that spawn Deno can update the repository even when the test only means to
verify behavior. Deno commands resolve dependencies and may refresh `deno.lock`
metadata. Generated configs, output files, and golden updates can also leave
workspace files behind if cleanup is not tied to failure paths.

## Repo Map

Use `@commonfabric/test-support/isolated-deno` for nested Deno commands that
need lockfile isolation.

For nested Deno checks that need a generated config:

```ts
import {
  runDenoCheckWithTemporaryConfig,
} from "@commonfabric/test-support/isolated-deno";
```

That helper keeps the generated Deno workspace config in the repository root,
where Deno requires workspace members to be nested under the config directory.
It points Deno at a temporary copy of `deno.lock`, so dependency metadata writes
do not touch the real lockfile. It also removes the generated root config in a
`finally` block.

For nested Deno commands that do not need a generated config:

```ts
import {
  runDenoCommandWithTemporaryLock,
} from "@commonfabric/test-support/isolated-deno";
```

Pass an argument builder and place the temporary lock path in the child Deno
command's `--lock` flag.

## Values

- A verification test must not change `deno.lock` or repository files.
- If a test needs mutable inputs or outputs, put them under `Deno.makeTempDir()`
  or an explicit test fixture copy.
- If a generated file must briefly live in the repository root for tool
  semantics, give it a unique dot-prefixed name and remove it in `finally`.
- If a test intentionally updates fixtures or goldens, gate the write behind an
  explicit environment variable such as `UPDATE_GOLDENS=1`.
- Treat `Deno.Command(Deno.execPath())` as a side-effect boundary. The child
  Deno process does not inherit the parent test runner's lockfile flags.

## Common Tells

Risky tests often contain `Deno.Command(Deno.execPath())`, `deno check`,
`deno task`, `deno install`, generated `deno.json` files, generated build
outputs, or direct writes to paths under the repository root.
