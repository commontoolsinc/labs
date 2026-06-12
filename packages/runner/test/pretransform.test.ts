import { assertMatch, assertNotMatch } from "@std/assert";
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
