import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..");

// The rosters' Join verb is wired to a rendered `<button onClick={join}>`, so
// its event is the serialized DOM click (`type`, `provenance`, target scalars).
// The runner's closed-world gate refuses any payload with an undeclared field
// against `additionalProperties: false`, which is what `Record<PropertyKey,
// never>` compiles to — every Join failed before the handler ran (the
// fabric-profiles bench, 2026-09-12; docs/history/roster-join-event-opened.md).
// This reads the compiled contract the way the update gate does and refuses a
// closed event on the Join stream, so restoring the closed shape is a red test
// rather than a silent regression.
const ROSTERS = [
  "packages/patterns/profile-roster-live-demo.tsx",
  "packages/patterns/shared-profile-roster/main.tsx",
];

async function compiledSchema(path: string): Promise<Record<string, any>> {
  const output = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    cwd: ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-net",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      join(ROOT, "packages/cli/mod.ts"),
      "check",
      path,
      "--pattern-json",
    ],
  });
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  const stdout = new TextDecoder().decode(output.stdout);
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

function resolved(schema: Record<string, any>, node: Record<string, any>) {
  const ref = typeof node.$ref === "string" ? node.$ref : undefined;
  if (!ref) return node;
  // A `$ref` that resolves to nothing must fail here, not pass below: an
  // unresolved reference would read as "no additionalProperties" and turn
  // this guard off silently.
  const key = ref.replace(/^#\/\$defs\//, "");
  const target = schema.$defs?.[key];
  assert(
    target && typeof target === "object",
    `the Join stream's ${ref} does not resolve in $defs`,
  );
  return { ...target, ...node, $ref: undefined };
}

for (const path of ROSTERS) {
  Deno.test(`${path}: the Join stream's event is not a closed object`, async () => {
    const pattern = await compiledSchema(path);
    const stream = pattern.resultSchema.properties.join;
    assert(
      Array.isArray(stream.asCell) && stream.asCell.includes("stream"),
      `join is a stream: ${JSON.stringify(stream)}`,
    );
    const event = resolved(pattern.resultSchema, stream);
    assert(
      event.additionalProperties !== false,
      `the Join event schema is closed, so a rendered click is refused: ${
        JSON.stringify(event)
      }`,
    );
  });
}
