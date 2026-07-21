import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import type { PatternCoverageSpan } from "@commonfabric/runner";
import { PATTERNS_ROOT, withRepositoryFileNames } from "./pattern-coverage.ts";

const span = (fileName: string): PatternCoverageSpan => ({
  fileName,
  id: 1,
  kind: "runtime",
  startLine: 1,
  endLine: 1,
  startColumn: 1,
  endColumn: 2,
});

// A worker reports two shapes of file name, depending on how the pattern reached
// it, and the gate only credits a line if its `SF:` path matches the file the
// source walk found. So resolve each shape the way the LCOV writer will and
// check it lands on a file that actually exists — a mapping that is merely
// plausible produces a path nothing matches, and the coverage silently
// evaporates rather than failing anything.
Deno.test("worker span file names resolve onto real pattern files", async () => {
  const cases = [
    {
      label: "fetched over HTTP, named by URL pathname",
      reported: "/api/patterns/system/default-app.tsx",
      expected: "/system/default-app.tsx",
      file: "system/default-app.tsx",
    },
    {
      label: "resolved from disk, named relative to the patterns root",
      reported: "/lunch-poll/main.tsx",
      expected: "/lunch-poll/main.tsx",
      file: "lunch-poll/main.tsx",
    },
  ];

  for (const { label, reported, expected, file } of cases) {
    const mapped = withRepositoryFileNames({
      spans: [span(reported)],
      hits: [{ fileName: reported, id: 1, count: 1 }],
    });
    assertEquals(mapped.spans[0].fileName, expected, label);
    // The hits must be renamed with the spans; a hit left under the old name
    // would key against nothing and report the line uncovered.
    assertEquals(mapped.hits[0].fileName, expected, label);

    // This is what `writePatternCoverageLcov({ root: PATTERNS_ROOT })` emits.
    const sourcePath = resolve(
      PATTERNS_ROOT,
      mapped.spans[0].fileName.slice(1),
    );
    assertEquals(sourcePath, resolve(PATTERNS_ROOT, file), label);
    assert(
      (await Deno.stat(sourcePath)).isFile,
      `${label}: ${sourcePath} is not a file in this checkout`,
    );
  }
});

Deno.test("a name that is not under the patterns route is left alone", () => {
  // Fabric mounts carry their own identity-based path and are reported as-is.
  const mounted = "/~cf/abc123/main.tsx";
  const mapped = withRepositoryFileNames({
    spans: [span(mounted)],
    hits: [{ fileName: mounted, id: 1, count: 1 }],
  });
  assertEquals(mapped.spans[0].fileName, mounted);
});
