import { assertEquals, assertThrows } from "@std/assert";
import { isModule } from "../../src/builder/types.ts";
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
import { SESRuntime } from "../../src/sandbox/ses-runtime.ts";
import type { VerifiedCallable } from "../../src/sandbox/types.ts";

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
  assertEquals(helper[CT_IMPLEMENTATION_REF], "main.tsx#001:helper");
  assertEquals(pure[CT_IMPLEMENTATION_REF], "main.tsx#002:pure");
  assertEquals(Object.isFrozen(data), true);
});

Deno.test("builder wrappers preserve factory semantics and primitive data wrappers stay valid", () => {
  const lifted = createBuilderWrapper("lift", "main.tsx#000:lifted", function (
    value: number,
  ) {
    return value + 1;
  });
  const handled = createBuilderWrapper(
    "handler",
    "main.tsx#001:handled",
    function (_event: unknown, _state: unknown) {},
  );
  const scalar = createDataWrapper("main.tsx#002:scale", [], 2);

  assertEquals(isModule(lifted), true);
  assertEquals((lifted as { type?: string }).type, "javascript");
  assertEquals(isModule(handled), true);
  assertEquals((handled as { wrapper?: string }).wrapper, "handler");
  assertEquals((handled as { writableProxy?: boolean }).writableProxy, true);
  assertEquals(scalar, 2);
});

Deno.test("runtime data wrappers reject values outside the v1 inert subset", () => {
  assertThrows(() =>
    createDataWrapper("main.tsx#003:lookup", [], new Set(["alpha", "beta"]))
  );
  assertThrows(() =>
    createDataWrapper(
      "main.tsx#004:index",
      [],
      new Map([["alpha", 1], ["beta", 2]]),
    )
  );
  assertThrows(() =>
    createDataWrapper("main.tsx#005:matcher", [], /^[a-z]+$/i)
  );
});

Deno.test("runtime wrappers reject obviously invalid input", () => {
  assertThrows(() =>
    createBuilderWrapper(
      "lift",
      "main.tsx#000:oops",
      1 as unknown as VerifiedCallable,
    )
  );
  assertThrows(() =>
    createPureFunctionWrapper(
      "main.tsx#001:oops",
      ["A"],
      {} as unknown as VerifiedCallable,
    )
  );
});

Deno.test("SES runtime keeps shared implementation refs indexed while other evaluations still own them", () => {
  const runtime = new SESRuntime() as unknown as {
    verifiedFunctions: Map<string, Map<string, VerifiedCallable>>;
    verifiedFunctionIndex: Map<string, VerifiedCallable>;
    resetVerifiedFunctions(evaluationId: string): void;
  };
  const first = (() => 1) as VerifiedCallable;
  const second = (() => 2) as VerifiedCallable;

  runtime.verifiedFunctions.set("eval-a", new Map([["shared-ref", first]]));
  runtime.verifiedFunctions.set("eval-b", new Map([["shared-ref", second]]));
  runtime.verifiedFunctionIndex.set("shared-ref", second);

  runtime.resetVerifiedFunctions("eval-a");

  assertEquals(runtime.verifiedFunctionIndex.get("shared-ref"), second);
});
