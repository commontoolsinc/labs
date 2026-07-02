import { assert, assertEquals } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

const DIAGNOSTIC_TYPE = "mergeable-push:read-then-push";

function getReadThenPushWarnings(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((d) =>
    d.type === DIAGNOSTIC_TYPE && d.severity === "warning"
  );
}

Deno.test("Mergeable push validation", async (t) => {
  await t.step(
    "warns on a dedup-then-push to the same collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.name)) return;",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = getReadThenPushWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      // The message points at the two recommended alternatives.
      assert(warnings[0]!.message.includes("addUnique"));
      assert(warnings[0]!.message.includes("set"));
      // It is non-fatal: no error of this type.
      assertEquals(
        diagnostics.filter((d) =>
          d.type === DIAGNOSTIC_TYPE && d.severity === "error"
        ).length,
        0,
      );
    },
  );

  await t.step(
    "does not warn on an unconditional push with no read",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "does not warn when the read is of a different collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "  log: Cell<string[]>;",
        "}>((event, { users, log }) => {",
        "  log.get();",
        "  users.push({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "reports one warning even with several pushes to the same read collection",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ a: string; b: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.a)) return;",
        "  users.push({ name: event.a });",
        "  users.push({ name: event.b });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 1);
    },
  );

  await t.step(
    "reports one warning for a lift-applied callback, not one per call site",
    async () => {
      // `lift(cb)(input)` exposes both the applied outer call and the unapplied
      // inner `lift(cb)` call, and both resolve to the same callback node.
      // Without per-callback deduplication the read-then-push warns twice.
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "declare const someInput: { items: number[] };",
        "",
        "export const doubled = lift((s: { items: number[] }) => {",
        "  const current = s.items;",
        "  s.items.push(current.length);",
        "  return current;",
        "})(someInput);",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 1);
    },
  );

  await t.step(
    "does not warn on the identity-addressed addUnique fix",
    async () => {
      const source = [
        'import { handler, Cell } from "commonfabric";',
        "",
        "interface User { name: string; }",
        "",
        "export const addUser = handler<{ name: string }, {",
        "  users: Cell<User[]>;",
        "}>((event, { users }) => {",
        "  const existing = users.get();",
        "  if (existing.some((u) => u.name === event.name)) return;",
        "  users.addUnique({ name: event.name });",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getReadThenPushWarnings(diagnostics).length, 0);
    },
  );
});
