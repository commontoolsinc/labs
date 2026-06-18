import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateFiles, validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

const DIAGNOSTIC_TYPE = "reactive-capture:unknown-type";
const RESULT_DIAGNOSTIC_TYPE = "pattern-result:unknown-type";

async function unknownCaptureWarnings(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((d) => d.type === DIAGNOSTIC_TYPE);
}

async function unknownResultWarnings(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((d) => d.type === RESULT_DIAGNOSTIC_TYPE);
}

Deno.test("unknown reactive capture diagnostic", async (t) => {
  await t.step(
    "warns when an untyped fetchData().result is captured in computed()",
    async () => {
      const source = `
        import { computed, fetchData, pattern } from "commonfabric";
        export default pattern<{ token: string }, { n: number }>(({ token }) => {
          const page = fetchData({ url: "http://x", mode: "json" });
          const pageResultRef = page.result;
          return computed(() => {
            const r: any = pageResultRef;
            return { n: r ? 1 : 0 };
          });
        });
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertEquals(warnings[0].severity, "warning");
      assertStringIncludes(warnings[0].message, "pageResultRef");
      assertStringIncludes(warnings[0].message, "unknown");
      assertStringIncludes(warnings[0].message, "undefined");
    },
  );

  await t.step(
    "does not warn when the fetchData call is typed",
    async () => {
      const source = `
        import { computed, fetchData, pattern } from "commonfabric";
        export default pattern<{ token: string }, { n: number }>(({ token }) => {
          const page = fetchData<{ items: number[] }>({ url: "http://x", mode: "json" });
          const pageResultRef = page.result;
          return computed(() => {
            const r = pageResultRef;
            return { n: r ? r.items.length : 0 };
          });
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 0);
    },
  );

  await t.step(
    "does not warn for an `any`-typed capture (any materializes via `true`)",
    async () => {
      const source = `
        import { computed, pattern } from "commonfabric";
        export default pattern<{ x: number }, { n: number }>(({ x }) => {
          const anyVal = (x as unknown) as any;
          return computed(() => ({ n: anyVal ? 1 : 0 }));
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 0);
    },
  );

  await t.step(
    "warns for an explicitly `unknown`-typed capture",
    async () => {
      const source = `
        import { computed, pattern } from "commonfabric";
        export default pattern<{ x: number }, { n: number }>(({ x }) => {
          const u = JSON.parse("{}") as unknown;
          return computed(() => ({ n: u ? 1 : 0 }));
        });
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "`u`");
    },
  );

  await t.step(
    "warns for an unknown capture inside a reactive array method",
    async () => {
      const source = `
        import { pattern } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{ items: number[] }, { out: boolean[] }>(
          ({ items }) => {
            const captured = pluck();
            return { out: items.map((x) => captured !== undefined) };
          },
        );
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "captured");
    },
  );

  await t.step(
    "warns for an unknown `ifElse` condition",
    async () => {
      const source = `
        import { pattern, ifElse, fetchData, UI } from "commonfabric";
        export default pattern<{}, { [UI]: any }>(() => {
          const page = fetchData({ url: "http://x", mode: "json" });
          return { [UI]: ifElse(page.result, "a", "b") };
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 1);
    },
  );

  await t.step(
    "warns for an unknown condition in a JSX conditional",
    async () => {
      const source = `
        import { pattern, fetchData, UI } from "commonfabric";
        export default pattern<{}, { [UI]: any }>(() => {
          const page = fetchData({ url: "http://x", mode: "json" });
          const r = page.result;
          return { [UI]: <div>{r ? "a" : "b"}</div> };
        });
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "`r`");
    },
  );

  await t.step(
    "warns for an unknown `when` condition",
    async () => {
      const source = `
        import { pattern, when, fetchData, UI } from "commonfabric";
        export default pattern<{}, { [UI]: any }>(() => {
          const page = fetchData({ url: "http://x", mode: "json" });
          return { [UI]: when(page.result, "shown") };
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 1);
    },
  );

  await t.step(
    "warns for an unknown `unless` condition",
    async () => {
      const source = `
        import { pattern, unless, fetchData, UI } from "commonfabric";
        export default pattern<{}, { [UI]: any }>(() => {
          const page = fetchData({ url: "http://x", mode: "json" });
          return { [UI]: unless(page.result, "fallback") };
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 1);
    },
  );

  await t.step(
    "an unknown ifElse branch warns at the consumer, not at the conditional",
    async () => {
      // Only the condition is checked. An unknown branch is not lost at the
      // ifElse — it flows out as the call's unknown result and is warned about
      // where that result is captured.
      const consumed = `
        import { pattern, ifElse, computed } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{ flag: boolean }, { n: number }>(({ flag }) => {
          const branch = pluck();
          const chosen = ifElse(flag, branch, 0);
          return computed(() => ({ n: chosen ? 1 : 0 }));
        });
      `;
      const warnings = await unknownCaptureWarnings(consumed);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "`chosen`");

      // Same unknown branch, but its result is never captured: nothing
      // materializes through the branch schema here, so no warning fires.
      const notConsumed = `
        import { pattern, ifElse, computed } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{ flag: boolean }, { n: number }>(({ flag }) => {
          const branch = pluck();
          const chosen = ifElse(flag, branch, 0);
          return computed(() => ({ n: flag ? 1 : 0 }));
        });
      `;
      assertEquals((await unknownCaptureWarnings(notConsumed)).length, 0);
    },
  );

  await t.step(
    "warns for an unknown capture inside an action()",
    async () => {
      const source = `
        import { pattern, action } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{}, { n: number }>(() => {
          const captured = pluck();
          const onClick = action(() => {
            const r = captured;
            return r;
          });
          return { n: 0 };
        });
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "captured");
    },
  );

  await t.step(
    "warns for an unknown capture inside a patternTool's pattern",
    async () => {
      const source = `
        import { pattern, patternTool, computed } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{}, { n: number }>(() => {
          const captured = pluck();
          const tool = patternTool(
            pattern<{ q: string }, { out: unknown }>(({ q }) =>
              computed(() => captured)
            ),
          );
          return { n: 0 };
        });
      `;
      const warnings = await unknownCaptureWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "captured");
    },
  );

  await t.step(
    "warns for an unknown capture nested in an otherwise-typed object",
    async () => {
      const source = `
        import { pattern, computed } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{}, { n: number }>(() => {
          const obj = { count: 1, payload: pluck() };
          return computed(() => ({ n: obj.payload ? obj.count : 0 }));
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 1);
    },
  );

  await t.step(
    "reports each captured expression once even when used repeatedly",
    async () => {
      const source = `
        import { computed, fetchData, pattern } from "commonfabric";
        export default pattern<{ token: string }, { n: number }>(({ token }) => {
          const page = fetchData({ url: "http://x", mode: "json" });
          const pageResultRef = page.result;
          return computed(() => {
            const a: any = pageResultRef;
            const b: any = pageResultRef;
            return { n: a && b ? 1 : 0 };
          });
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 1);
    },
  );

  await t.step(
    "does not warn for a fully-typed reactive pattern",
    async () => {
      const source = `
        import { computed, pattern } from "commonfabric";
        export default pattern<{ count: number }, { doubled: number }>(({ count }) => {
          return computed(() => ({ doubled: count * 2 }));
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 0);
    },
  );

  await t.step(
    "does not warn when a reactive value is returned directly and cast to any",
    async () => {
      // Cast to `any` and returned straight from the body: not a capture, and
      // the output schema is `true` (any), not `{ type: "unknown" }`. Neither
      // the capture nor the result diagnostic fires.
      const source = `
        import { pattern, fetchData } from "commonfabric";
        export default pattern<{}, { result: any }>(() => {
          const page = fetchData({ url: "http://x", mode: "json" });
          return { result: page.result as any };
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 0);
      assertEquals((await unknownResultWarnings(source)).length, 0);
    },
  );

  await t.step(
    "warns (result diagnostic) for an unknown value in the inferred pattern output",
    async () => {
      // Not a capture, so the capture diagnostic stays silent. The producer-side
      // result diagnostic flags it: the field lowers to `{ type: "unknown" }`,
      // and a consumer reading it back gets undefined.
      const source = `
        import { pattern, wish } from "commonfabric";
        export default pattern(() => {
          const noteWish = wish({ query: "#note" });
          return { result: noteWish.result };
        });
      `;
      assertEquals((await unknownCaptureWarnings(source)).length, 0);
      const warnings = await unknownResultWarnings(source);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "`result`");
    },
  );

  await t.step(
    "does not warn (result diagnostic) for a typed pattern output",
    async () => {
      const source = `
        import { pattern, wish } from "commonfabric";
        export default pattern<{}, { result: { id: string } }>(() => {
          const w = wish<{ id: string }>({ query: "#note" });
          return { result: w.result };
        });
      `;
      assertEquals((await unknownResultWarnings(source)).length, 0);
    },
  );

  await t.step(
    "warns per file when two files share a capture at the same offset",
    async () => {
      // The dedup state is shared across every file in a compilation, and the
      // dedup key includes the file name; otherwise identical-offset captures in
      // different files collide and one warning is dropped.
      const source = `
        import { computed, pattern } from "commonfabric";
        function pluck<T>(s?: { value: T }): T { return s?.value as T; }
        export default pattern<{}, { n: number }>(() => {
          const captured = pluck();
          return computed(() => ({ n: captured ? 1 : 0 }));
        });
      `;
      const { diagnostics } = await validateFiles(
        { "/a.tsx": source, "/b.tsx": source },
        { types: COMMONFABRIC_TYPES },
      );
      const warnings = diagnostics.filter((d) => d.type === DIAGNOSTIC_TYPE);
      assertEquals(warnings.length, 2);
      assertEquals(
        new Set(warnings.map((w) => w.fileName)).size,
        2,
      );
    },
  );
});
