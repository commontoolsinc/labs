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
import { createCompartmentGlobals } from "../../src/sandbox/compartment-globals.ts";
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

Deno.test("runtime data wrappers accept frozen-safe RegExp values and reject unsupported shapes", () => {
  const matcher = createDataWrapper("main.tsx#003:matcher", [], /^[a-z]+$/i);
  assertEquals(Object.isFrozen(matcher), true);
  assertEquals(matcher.test("Alpha"), true);

  assertThrows(() =>
    createDataWrapper("main.tsx#004:lookup", [], new Set(["alpha", "beta"]))
  );
  assertThrows(() =>
    createDataWrapper(
      "main.tsx#005:index",
      [],
      new Map([["alpha", 1], ["beta", 2]]),
    )
  );
  assertThrows(() =>
    createDataWrapper("main.tsx#006:global-matcher", [], /[a-z]+/g)
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

Deno.test("compartment globals harden __ctHelpers before exposing them", () => {
  const CompartmentCtor = (globalThis as typeof globalThis & {
    Compartment: new (
      globals: Record<string, unknown>,
    ) => { evaluate<T>(source: string): T };
  }).Compartment;
  const compartment = new CompartmentCtor(
    createCompartmentGlobals(console, {
      nested: { count: 1 },
      h() {
        return 1;
      },
    }),
  );

  const result = compartment.evaluate<{
    rootFrozen: boolean;
    nestedFrozen: boolean;
    hFrozen: boolean;
    extra: unknown;
    count: number;
  }>(`(() => {
    const helpers = globalThis.__ctHelpers;
    try {
      helpers.extra = 1;
    } catch {
      // Mutation should fail once helpers are hardened.
    }
    try {
      helpers.nested.count = 2;
    } catch {
      // Nested mutations should fail once helpers are hardened.
    }
    return {
      rootFrozen: Object.isFrozen(helpers),
      nestedFrozen: Object.isFrozen(helpers.nested),
      hFrozen: Object.isFrozen(helpers.h),
      extra: helpers.extra,
      count: helpers.nested.count,
    };
  })()`);

  assertEquals(result, {
    rootFrozen: true,
    nestedFrozen: true,
    hFrozen: true,
    extra: undefined,
    count: 1,
  });
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

Deno.test("SES runtime prefers the newest surviving callable when shared refs outlive an evaluation", () => {
  const runtime = new SESRuntime() as unknown as {
    verifiedFunctions: Map<string, Map<string, VerifiedCallable>>;
    verifiedFunctionIndex: Map<string, VerifiedCallable>;
    resetVerifiedFunctions(evaluationId: string): void;
  };
  const oldest = (() => 1) as VerifiedCallable;
  const newer = (() => 2) as VerifiedCallable;
  const newest = (() => 3) as VerifiedCallable;

  runtime.verifiedFunctions.set("eval-a", new Map([["shared-ref", oldest]]));
  runtime.verifiedFunctions.set("eval-b", new Map([["shared-ref", newer]]));
  runtime.verifiedFunctions.set("eval-c", new Map([["shared-ref", newest]]));
  runtime.verifiedFunctionIndex.set("shared-ref", newest);

  runtime.resetVerifiedFunctions("eval-c");

  assertEquals(runtime.verifiedFunctionIndex.get("shared-ref"), newer);
});
