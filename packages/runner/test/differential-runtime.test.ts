import {
  compareExports,
  compareMappedError,
  comparePatternMappedError,
  comparePatternResult,
  comparePatternScenario,
} from "./support/runtime-compare.ts";

Deno.test("SES runtime matches legacy exports for valid authored programs", async () => {
  await compareExports({
    main: "/main.tsx",
    files: [
      {
        name: "/util.ts",
        contents: [
          "export function double(value: number) { return value * 2; }",
          "export const answer = 42;",
        ].join("\n"),
      },
      {
        name: "/main.tsx",
        contents: [
          "import { answer } from './util.ts';",
          "export default answer;",
        ].join("\n"),
      },
    ],
  });
});

Deno.test("SES runtime matches legacy exports for top-level regex and IIFE-computed data", async () => {
  await compareExports({
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "const matcher = /^[a-z.]+$/i;",
          "const label = ['clusters', 'north', 'alpha'].map((part) => String(part)).join('.');",
          "const summary = (() => ({ label, matches: matcher.test(label) }))();",
          "export default summary;",
        ].join("\n"),
      },
    ],
  });
});

Deno.test("SES runtime matches legacy exports for bracket-accessed top-level data", async () => {
  await compareExports({
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "const priorityOrder = { low: 2, medium: 1, high: 0 } as const;",
          "const criticalRank = priorityOrder['high'];",
          "export default criticalRank;",
        ].join("\n"),
      },
    ],
  });
});

Deno.test("SES runtime matches legacy exports for top-level Map and Set data", async () => {
  await compareExports({
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "const priorityByName = new Map([['low', 2], ['high', 0]]);",
          "const enabledChannels = new Set(['email', 'sms']);",
          "export default { priorityByName, enabledChannels };",
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
            "export const bias = 3;",
          ].join("\n"),
        },
        {
          name: "/main.tsx",
          contents: [
            "import { lift, pattern } from 'commonfabric';",
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

Deno.test("SES runtime matches legacy pattern behavior for hoisted handler and inline derive/computed flows", async () => {
  await comparePatternScenario(
    {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Cell, computed, derive, handler, lift, pattern } from 'commonfabric';",
            "const scale = 2;",
            "const double = lift((value: number) => value * scale);",
            "const increment = handler((event: { amount?: number } | undefined, context: { value: Cell<number> }) => {",
            "  const amount = typeof event?.amount === 'number' ? event.amount : 1;",
            "  context.value.set((context.value.get() ?? 0) + amount);",
            "});",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  const doubled = double(value);",
            "  const label = derive(doubled, (current) => `value:${current}`);",
            "  const isEven = computed(() => ((value ?? 0) % 2) === 0);",
            "  return { value, doubled, label, isEven, increment: increment({ value }) };",
            "});",
          ].join("\n"),
        },
      ],
    },
    { value: 2 },
    [
      { observe: ["value", "doubled", "label", "isEven"] },
      {
        events: [{ stream: "increment", payload: { amount: 3 } }],
        observe: ["value", "doubled", "label", "isEven"],
      },
    ],
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
            "export function fail(event: { value?: string }) {",
            "  throw new Error(`boom:${event?.value ?? 'none'}`);",
            "}",
            "export default fail;",
          ].join("\n"),
        },
      ],
    },
    (main) =>
      (main.fail as (event: { value: string }) => never)({ value: "x" }),
  );
});

Deno.test("SES runtime preserves mapped hoisted handler failures against legacy eval", async () => {
  await comparePatternMappedError(
    {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Cell, handler, pattern } from 'commonfabric';",
            "const explode = handler((_event: unknown, context: { value: Cell<number> }) => {",
            "  throw new Error(`boom:${context.value.get() ?? 0}`);",
            "});",
            "export default pattern<{ value: number }>(({ value }) => ({",
            "  value,",
            "  explode: explode({ value }),",
            "}));",
          ].join("\n"),
        },
      ],
    },
    { value: 7 },
    { stream: "explode", payload: {} },
  );
});
