import { assertEquals, assertThrows } from "@std/assert";
import {
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
} from "../../src/sandbox/types.ts";
import {
  createBuilderWrapper,
  createDataWrapper,
  createFunctionWrapper,
  createPureFunctionWrapper,
} from "../../src/sandbox/runtime-helpers.ts";

Deno.test("runtime wrappers tag and harden approved values", () => {
  const builder = createBuilderWrapper("lift", "main.tsx#000:lifted", function (
    value: number,
  ) {
    return value + 1;
  });
  const helper = createFunctionWrapper("main.tsx#001:helper", function () {
    return 1;
  });
  const pure = createPureFunctionWrapper(
    "main.tsx#002:pure",
    ["CONFIG"],
    function () {
      return 2;
    },
  );
  const data = createDataWrapper("main.tsx#003:data", [], { ok: true });

  assertEquals(builder[CT_WRAPPER_KIND], "lift");
  assertEquals(builder[CT_ITEM_ID], "main.tsx#000:lifted");
  assertEquals(builder[CT_IMPLEMENTATION_REF], "main.tsx#000:lifted");
  assertEquals(Object.isFrozen(builder), true);
  assertEquals(helper[CT_IMPLEMENTATION_REF], "main.tsx#001:helper");
  assertEquals(pure[CT_IMPLEMENTATION_REF], "main.tsx#002:pure");
  assertEquals(Object.isFrozen(data), true);
});

Deno.test("runtime wrappers reject obviously invalid input", () => {
  assertThrows(() =>
    createBuilderWrapper("lift", "main.tsx#000:oops", 1 as unknown as Function)
  );
  assertThrows(() =>
    createPureFunctionWrapper(
      "main.tsx#001:oops",
      ["A"],
      {} as unknown as Function,
    )
  );
});
