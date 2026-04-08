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
