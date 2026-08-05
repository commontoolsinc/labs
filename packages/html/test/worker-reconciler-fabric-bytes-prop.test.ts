/**
 * A `FabricBytes` prop must survive the worker → DOM boundary with its bytes
 * intact.
 *
 * The reconciler sends every prop value to the main thread over `postMessage`
 * (structured clone), after passing it through `convertCellsToLinks` — see
 * `transformPropValue` in `../src/worker/reconciler.ts`. `convertCellsToLinks`
 * deliberately leaves a `FabricPrimitive` whole rather than rebuilding it from
 * its entries, because its state lives in private fields and it has zero
 * enumerable own properties.
 *
 * That is exactly what makes it unclonable: structured clone copies enumerable
 * own properties and drops the prototype, so a `FabricBytes` arrives on the
 * main thread as a bare `{}` — no bytes, no `slice()`, no `length`. Every DOM
 * consumer of image bytes then has nothing to read: `<cf-image>`'s
 * `_coerceBytes` returns null for that shape, so it mints no object URL and
 * `render()` returns null, leaving whatever is behind the element visible.
 *
 * Observed in the lunch-poll pattern: generated art fetches fine (the pattern
 * side sees the bytes and offers "keep this art"), but the thumbnail never
 * paints — the placeholder shows through.
 */
import { assert, assertEquals } from "@std/assert";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { convertCellsToLinks, KeepAsCell } from "@commonfabric/runner";

/** The JPEG magic number, so a failure reads as real image bytes going missing. */
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

/**
 * The transform `WorkerReconciler.transformPropValue` applies to a non-`style`
 * prop before handing it to `postMessage`.
 */
function transformPropValue(value: unknown): unknown {
  return convertCellsToLinks(value, {
    doNotConvertCellResults: true,
    includeSchema: true,
    keepAsCell: KeepAsCell.OnlyStream,
  });
}

/** What `postMessage` does to the value on the way to the main thread. */
function crossWorkerBoundary(value: unknown): unknown {
  return structuredClone(value);
}

/**
 * `<cf-image>`'s byte coercion (packages/ui/src/v2/components/cf-image), as the
 * DOM side sees the delivered prop. Kept as a local mirror so this test does
 * not pull the UI package in; the shapes it accepts are what matter here.
 */
function coerceBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const maybe = value as {
    slice?: (start?: number, end?: number) => unknown;
    length?: number;
  };
  if (typeof maybe.slice === "function") {
    try {
      return new Uint8Array(maybe.slice() as ArrayLike<number>);
    } catch {
      // fall through
    }
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (typeof maybe.length === "number") {
    try {
      return Uint8Array.from(value as ArrayLike<number>);
    } catch {
      return null;
    }
  }
  return null;
}

Deno.test("FabricBytes has no enumerable own properties to clone", () => {
  const bytes = new FabricBytes(IMAGE_BYTES);

  // The premise: its state is private, so a structural copy carries nothing.
  assertEquals(Object.keys(bytes), []);
  // ...while the instance itself reads back fine inside the worker.
  assertEquals(Array.from(bytes.slice()), Array.from(IMAGE_BYTES));
});

Deno.test("a FabricBytes prop survives the worker boundary", () => {
  const delivered = crossWorkerBoundary(transformPropValue(
    new FabricBytes(IMAGE_BYTES),
  ));

  const recovered = coerceBytes(delivered);
  assert(
    recovered !== null,
    "image bytes were lost crossing the worker boundary: the DOM side " +
      `received ${JSON.stringify(delivered)}, which no consumer can read`,
  );
  assertEquals(Array.from(recovered), Array.from(IMAGE_BYTES));
});

Deno.test("a FabricBytes nested in a props object survives the boundary", () => {
  // The shape a pattern actually renders: <cf-image bytes={...} mediaType=... />
  const delivered = crossWorkerBoundary(transformPropValue({
    bytes: new FabricBytes(IMAGE_BYTES),
    mediaType: "image/webp",
  })) as { bytes?: unknown; mediaType?: string };

  assertEquals(delivered.mediaType, "image/webp");
  const recovered = coerceBytes(delivered.bytes);
  assert(
    recovered !== null,
    "image bytes were lost crossing the worker boundary: `bytes` arrived as " +
      `${JSON.stringify(delivered.bytes)}`,
  );
  assertEquals(Array.from(recovered), Array.from(IMAGE_BYTES));
});
