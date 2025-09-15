# @commontools/test-support

Shared testing infrastructure for CommonTools packages. This package currently
exports a configurable fixture runner that powers schema generator and
transformer tests without duplicating boilerplate code.

## Usage

```ts
import { defineFixtureSuite } from "@commontools/test-support/fixture-runner";

await defineFixtureSuite({
  suiteName: "Schema fixtures",
  rootDir: "./test/fixtures/schema",
  expectedPath: (fixture) => `${fixture.stem}.expected.json`,
  async execute(fixture) {
    // run transformer and return normalized JSON
  },
  async loadExpected(fixture) {
    const text = await Deno.readTextFile(fixture.expectedPath);
    return JSON.parse(text);
  },
  compare(actual, expected) {
    expect(actual).toEqual(expected);
  },
});
```

The configuration API is flexible enough to handle text-based outputs,
structured comparisons, per-suite warmup hooks, grouped fixture descriptions,
and golden updates controlled via the `UPDATE_GOLDENS` environment variable.

For additional examples see `packages/schema-generator/test/fixtures-runner.test.ts`
and `packages/js-runtime/test/fixture-based.test.ts` after migration.
