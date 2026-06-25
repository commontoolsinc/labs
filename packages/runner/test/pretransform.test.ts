import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

Deno.test("transformInjectHelperModule transforms by default and respects cf-disable-transform", () => {
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          'import { pattern } from "commonfabric";',
          "export default pattern<{ value: string }>(({ value }) => ({ value }));",
        ].join("\n"),
      },
      {
        name: "/plain.tsx",
        contents: [
          "/// <cf-disable-transform />",
          "export const value = 1;",
        ].join("\n"),
      },
    ],
  };

  const transformed = transformInjectHelperModule(program);
  const main = transformed.files.find((file) => file.name === "/main.tsx")!;
  const plain = transformed.files.find((file) => file.name === "/plain.tsx")!;

  assertMatch(
    main.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertNotMatch(main.contents, /cts-enable/);

  assertNotMatch(
    plain.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertNotMatch(plain.contents, /cf-disable-transform/);
});

Deno.test("transformInjectHelperModule injects JS-syntax helpers into .js sources", () => {
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: "export default 42;",
      },
      {
        name: "/helper.js",
        contents: "export const add = (x, y) => x + y;",
      },
    ],
  };

  const transformed = transformInjectHelperModule(program);
  const main = transformed.files.find((file) => file.name === "/main.tsx")!;
  const helper = transformed.files.find((file) => file.name === "/helper.js")!;

  // Both get the helper import...
  assertMatch(main.contents, /import \{ __cfHelpers \} from "commonfabric";/);
  assertMatch(
    helper.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  // ...but the `h` shim in the .js file must not carry a TS type annotation
  // ("Type annotations can only be used in TypeScript files").
  assertMatch(main.contents, /function h\(\.\.\.args: any\[\]\)/);
  assertMatch(helper.contents, /function h\(\.\.\.args\)/);
  assertNotMatch(helper.contents, /any\[\]/);
});

// Coverage remapping assumes this pretransform only adds the one-line helper
// prelude. Mixed import splitting must preserve the original line count.
Deno.test("mixed import rewrite must not drift coverage line numbers", () => {
  const markerOutputLine = (contents: string): number =>
    transformInjectHelperModule({
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents }],
    }).files[0]!.contents.split("\n").findIndex((line) =>
      line.includes("MARKER")
    ) + 1;

  // Control: single-line attributes preserve the count. MARKER is authored line
  // 2, so after the one-line helper prepend it lands on output line 3.
  const singleLineAttributes =
    `import D, { a } from "x" with { type: "json" };\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(singleLineAttributes), 3);

  // MARKER is authored line 4, so after the one-line helper prepend it must land
  // on output line 5. The rewrite must not add lines for multi-line attributes.
  const multiLineAttributes =
    `import D, { a } from "x" with {\n  type: "json"\n};\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(multiLineAttributes), 5);

  // Multi-line named bindings must not drift either. MARKER is authored line 5,
  // so after the helper prepend it lands on output line 6.
  const multiLineNamedBindings =
    `import D, {\n  a,\n  b,\n} from "x";\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(multiLineNamedBindings), 6);
});
