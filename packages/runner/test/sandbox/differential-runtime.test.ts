import {
  compareExports,
  compareMappedError,
  comparePatternResult,
} from "../support/runtime-compare.ts";

Deno.test("SES runtime matches legacy exports for valid authored programs", async () => {
  await compareExports({
    main: "/main.tsx",
    files: [
      {
        name: "/util.ts",
        contents: [
          "/// <cts-enable />",
          "export function double(value: number) { return value * 2; }",
          "export const answer = 42;",
        ].join("\n"),
      },
      {
        name: "/main.tsx",
        contents: [
          "/// <cts-enable />",
          "import { answer } from './util.ts';",
          "export default answer;",
        ].join("\n"),
      },
    ],
  });
});

Deno.test("SES runtime preserves mapped authored error locations against legacy eval", async () => {
  await compareMappedError(
    {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "export default function boom(): never {",
            "  throw new Error('boom');",
            "}",
          ].join("\n"),
        },
      ],
    },
    (main) => (main.default as () => never)(),
  );
});

Deno.test("SES runtime matches legacy pattern outputs for hoisted lift and local imports", async () => {
  await comparePatternResult(
    {
      main: "/main.tsx",
      files: [
        {
          name: "/math.ts",
          contents: [
            "/// <cts-enable />",
            "export const bias = 3;",
          ].join("\n"),
        },
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { lift, pattern } from 'commontools';",
            "import { bias } from './math.ts';",
            "const project = lift((value: number) => value * 2 + bias);",
            "export default pattern<{ value: number }>(({ value }) => ({ total: project(value) }));",
          ].join("\n"),
        },
      ],
    },
    { value: 5 },
  );
});

Deno.test("SES runtime matches legacy mapped named-export helper failures", async () => {
  await compareMappedError(
    {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "export function fail(event: { value?: string }) {",
            "  throw new Error(`boom:${event?.value ?? 'none'}`);",
            "}",
            "export default fail;",
          ].join("\n"),
        },
      ],
    },
    (main) => (main.fail as (event: { value: string }) => never)({ value: "x" }),
  );
});
