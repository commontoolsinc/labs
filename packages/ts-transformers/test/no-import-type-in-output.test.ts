import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";

// Invariant: no transformed output (golden) may reference a commonfabric export
// via the inline `import("commonfabric").X` import-type form. The transformer
// injects `import { __cfHelpers } from "commonfabric"` and re-exposes the whole
// namespace as `__cfHelpers`, so every commonfabric type must be emitted as the
// always-resolvable `__cfHelpers.X` qualified form. The inline import-type form
// leaks when a synthesized type annotation (e.g. a lift's result type) bypasses
// the `qualifyCommonFabricTypeRefs` normalizer.
//
// This guard covers EVERY transform path at once (any path that synthesizes an
// emitted type annotation), not just the ones an individual fixture happens to
// exercise. A regression in the normalizer or a new un-normalized
// `checker.typeToTypeNode` call site that reaches emit will fail here with the
// exact file:line.

const FIXTURES_ROOT = new URL("./fixtures/", import.meta.url);
const FORBIDDEN = 'import("commonfabric")';

Deno.test('no golden output contains the inline import("commonfabric") type form', async () => {
  const offenders: string[] = [];

  for await (
    const entry of walk(FIXTURES_ROOT, {
      includeDirs: false,
      match: [/\.expected\.[a-z]+$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(FORBIDDEN)) {
        offenders.push(`${entry.path}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assertEquals(
    offenders,
    [],
    `Found ${offenders.length} inline import("commonfabric") reference(s) in ` +
      `golden output. These must be the canonical __cfHelpers.X form. ` +
      `Offenders:\n${offenders.join("\n")}`,
  );
});
