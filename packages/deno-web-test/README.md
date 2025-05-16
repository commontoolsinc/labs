# deno-web-test

`deno-web-test` is a test runner for running Deno tests in a browser. This is
used in code compatible with both Deno and browsers in order to test browser
functionality.

## Usage

Write a test using `Deno.test`:

```ts
// add.test.ts
import { assert } from "@std/assert";

Deno.test("add", function () {
  assert((5 + 5) === 10, "math checks out");
});
```

Optionally add a `deno-web-test.config.ts` to the project root to configure the
runner. See [config.ts](/deno-web-test/config.ts) for all options.

```ts
export default {
  headless: true,
  devtools: false,
  product: "chrome",
  args: ["--enable-experimental-web-platform-features"],
  pipeConsole: true,
  include: {
    "path/static-asset.json": "static/asset.json",
  }
};
```

Finally, run `deno-web-test/cli.ts`, which takes a glob of files to test.

```json
{
  "tasks": {
    "test": "deno run -A deno-web-test/cli.ts *.test.ts"
  }
}
```

## Support

Currently only the `Deno.test(string, fn)` signature works. Using other
signatures, or the BDD framework in `@std/testing/bdd` is not yet supported.

## Testing

For testing `deno-web-test` itself, the test suites (running in Deno itself) run
`deno-web-test` for subprojects to test features. Due to being in a workspace,
and not wanting to clutter the workspace with these test directories, and Deno
attempting to enforce this, the test packages are moved to a temporary directory
and the test task rewritten to target the local `cli.ts` export. This could be
relaxed if moved outside of the workspace.
