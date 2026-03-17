import { compareExports, compareMappedError } from "../support/runtime-compare.ts";

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
