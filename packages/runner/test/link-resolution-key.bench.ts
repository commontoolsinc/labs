/**
 * Microbenchmark: JSON.stringify vs null-byte concat for link cycle-detection
 * keys.
 *
 * Context: PERF-3 proposes replacing JSON.stringify([space, id, path]) with
 * string concat. Naive separators (|, /) cause collisions when path segments
 * contain the separator. Null-byte concat with a length prefix is ~2x faster
 * than JSON.stringify and collision-safe.
 */

// Representative input sizes based on real usage
const inputs = {
  short: {
    space: "did:key:z6Mk",
    id: "baedrei123",
    path: ["name"] as readonly string[],
  },
  typical: {
    space: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    id: "baedreiabc123def456ghi789jkl012mno345pqr678stu901vwx",
    path: ["data", "items", "0", "title"] as readonly string[],
  },
  long_path: {
    space: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    id: "baedreiabc123def456ghi789jkl012mno345pqr678stu901vwx",
    path: [
      "data",
      "items",
      "0",
      "nested",
      "deeply",
      "structured",
      "value",
      "with",
      "many",
      "segments",
    ] as readonly string[],
  },
  tricky: {
    space: "did:key:z6Mk",
    id: "baedrei|with|pipes",
    path: ["a/b", "c|d"] as readonly string[],
  },
};

// --- Current code (JSON.stringify) ---
function keyJsonStringify(
  space: string,
  id: string,
  path: readonly string[],
): string {
  return JSON.stringify([space, id, path]);
}

// --- Proposed replacement: null-byte concat with length prefix ---
function keyConcatSafe(
  space: string,
  id: string,
  path: readonly string[],
): string {
  return `${space}\0${id}\0${path.length}\0${path.join("\0")}`;
}

// Verify collision safety: these must produce different keys
const a = keyConcatSafe("s", "id", ["a/b"]);
const b = keyConcatSafe("s", "id", ["a", "b"]);
if (a === b) {
  throw new Error(
    "COLLISION: concat-safe produced identical keys for different paths",
  );
}
console.log("✓ concat-safe distinguishes paths correctly");

for (const [name, input] of Object.entries(inputs)) {
  Deno.bench(`JSON.stringify [${name}]`, () => {
    keyJsonStringify(input.space, input.id, input.path);
  });

  Deno.bench(`concat-safe [${name}]`, () => {
    keyConcatSafe(input.space, input.id, input.path);
  });
}
