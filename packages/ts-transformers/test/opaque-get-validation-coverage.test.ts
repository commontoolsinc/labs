import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function getOpaqueGetErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) =>
    d.type === "opaque-get:invalid-call" && d.severity === "error"
  );
}

// isReactiveExpression: identifier bound to a pattern-callback parameter is a
// reactive value, so calling .get() on it (via a structural fallback, not a
// branded type) is flagged as an invalid opaque .get() call.
Deno.test(
  "opaque-get flags .get() on a destructured pattern-callback parameter",
  async () => {
    const source = `      import { pattern } from "commonfabric";

      interface State { title: string; }

      export default pattern<State>(({ title }) => {
        const t = title.get();
        return { t };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(
      errors[0]!.message,
      "is a reactive value that can be accessed directly",
    );
  },
);

// isPatternCallbackParameter: the whole pattern input parameter (not
// destructured) is reactive, so member access rooted at it and then .get() is
// flagged. This drives the walk up to the enclosing function and its builder
// call.
Deno.test(
  "opaque-get flags .get() on a member of the whole pattern input parameter",
  async () => {
    const source = `      import { pattern } from "commonfabric";

      interface State { nested: { value: number }; }

      export default pattern<State>((state) => {
        const v = state.nested.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

// isReactiveInitializer: a local variable initialized directly from a
// reactive-origin call (computed()) is reactive; .get() on it is flagged.
Deno.test(
  "opaque-get flags .get() on a local initialized from computed()",
  async () => {
    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        const doubled = computed(() => count * 2);
        const bad = doubled.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "computed()");
  },
);

// isReactiveInitializer unwrapping: the reactive-origin call is wrapped in a
// parenthesized / non-null / property-access chain before assignment, and the
// validator peels those layers off to find the origin call underneath.
Deno.test(
  "opaque-get flags .get() on a local initialized from a wrapped reactive-origin call",
  async () => {
    const source = `      import { computed, pattern } from "commonfabric";

      interface Shape { inner: number; }

      export default pattern<{ count: number }>(({ count }) => {
        const wrapped = (computed(() => ({ inner: count } as Shape)))!.inner;
        const bad = wrapped.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

// isReactiveExpression binding-element branch: a value destructured out of a
// local whose initializer is a reactive-origin call is still reactive, so
// .get() on the destructured binding is flagged.
Deno.test(
  "opaque-get flags .get() on a binding destructured from a reactive local",
  async () => {
    const source = `      import { computed, pattern } from "commonfabric";

      interface Shape { a: number; b: number; }

      export default pattern<{ count: number }>(({ count }) => {
        const { a } = computed(() => ({ a: count, b: count } as Shape));
        const bad = a.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

// isPatternCallbackParameter walks up from the enclosing function to its
// builder call. When the callback is wrapped in parentheses, the function's
// immediate parent is not the call expression, so the walk climbs through the
// parenthesized wrapper before reaching pattern(). The .get() on the reactive
// input must still be flagged.
Deno.test(
  "opaque-get flags .get() when the pattern callback is parenthesized",
  async () => {
    const source = `      import { pattern } from "commonfabric";

      interface State { title: string; }

      export default pattern<State>(((state) => {
        const t = state.title.get();
        return { t };
      }));
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

// isReactiveExpression bails out when the receiver identifier has no resolved
// symbol: an unresolvable receiver cannot be proven reactive, so no
// opaque-get diagnostic is produced for it (the structural fallback returns
// false at the missing-symbol guard).
Deno.test(
  "opaque-get does not flag .get() on an unresolvable identifier",
  async () => {
    const source = `      import { pattern } from "commonfabric";

      export default pattern(() => {
        // @ts-ignore intentional unresolved reference
        const v = undeclaredThing.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 0);
  },
);

// A .get() on a genuine Cell/Writable must NOT be flagged by this validator:
// cellKind === "cell" returns early, exercising the non-reactive path.
Deno.test(
  "opaque-get does not flag .get() on a Writable cell",
  async () => {
    const source = `      import { pattern, Cell } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const v = count.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 0);
  },
);
