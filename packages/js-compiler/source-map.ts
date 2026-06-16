import { SourceMap } from "./interface.ts";
import {
  MappedPosition,
  SourceMapConsumer,
  SourceMapGenerator,
} from "source-map-js";
import { LRUCache } from "@commonfabric/utils/cache";

export type { MappedPosition };

/**
 * Compose a single bundle source map for the concatenated module bodies
 * (`[...bodies].join("\n")`) from each module's own source map, offsetting each
 * module's generated lines by its starting line in the concatenation.
 *
 * The ESM module-record loader resolves a function's location by `indexOf`-ing
 * its source into the concatenated bundle `script`, then calling
 * `mapPosition(bundleFilename, line, col)`. Without a registered map that stays
 * a raw bundle coordinate (`<loadId>.js:..`), which CFC verified-source identity
 * rejects. Registering this composed map resolves it back to the original
 * authored source (e.g. `/main.tsx:6:2`) — parity with the AMD isolate path.
 *
 * Returns `undefined` if no module contributed a map.
 */
export function composeBundleSourceMap(
  // `source`, when set, overrides the map's recorded source path for ALL of that
  // module's mappings. The per-module compiler maps record only the basename
  // (e.g. `main.tsx`), but the CFC verified-source set is keyed by the full
  // module path (e.g. `/<id>/dir/main.tsx`); overriding makes resolved
  // coordinates match the set so verified-source identity holds.
  modules: ReadonlyArray<{ body: string; map?: SourceMap; source?: string }>,
  bundleFilename: string,
  // Generated-line offset applied to the FIRST module. Use this when the
  // generated text is wrapped by a fixed prefix of N lines (e.g. the ESM
  // loader's `(function (exports, require, module) {\n` factory wrapper adds 1
  // line before the compiled body), so coordinates from `new Error().stack`
  // (1-based, relative to the eval'd string) map correctly.
  startLineOffset = 0,
): SourceMap | undefined {
  const generator = new SourceMapGenerator({ file: bundleFilename });
  let lineOffset = startLineOffset;
  let any = false;
  for (const { body, map, source } of modules) {
    if (map) {
      const consumer = new SourceMapConsumer(map);
      consumer.eachMapping((m) => {
        if (
          m.source == null || m.originalLine == null ||
          m.originalColumn == null
        ) return;
        generator.addMapping({
          generated: {
            line: m.generatedLine + lineOffset,
            column: m.generatedColumn,
          },
          original: { line: m.originalLine, column: m.originalColumn },
          source: source ?? m.source,
          name: m.name ?? undefined,
        });
        any = true;
      });
      const contents =
        (map as { sourcesContent?: (string | null)[] }).sourcesContent;
      if (source) {
        // Source overridden to a single full module path: register that
        // module's content under the override name so DevTools can still show
        // the authored text (parity with the AMD bundle map). Per-module
        // compiler maps carry exactly one source, so the first content is it.
        const content = contents?.find((c) => c != null);
        if (content != null) generator.setSourceContent(source, content);
      } else {
        const sources = map.sources ?? [];
        if (contents) {
          sources.forEach((src, i) => {
            const content = contents[i];
            if (src != null && content != null) {
              generator.setSourceContent(src, content);
            }
          });
        }
      }
    }
    // Lines this body occupies in the "\n"-joined bundle = (newlines in body)+1.
    // Robust to trailing newlines, unlike split().length.
    lineOffset += (body.match(/\n/g)?.length ?? 0) + 1;
  }
  if (!any) return undefined;
  return JSON.parse(generator.toString()) as SourceMap;
}

/**
 * Build an IDENTITY source map for a compiled body whose authored source map
 * was not retained — every generated line maps to the same line/column of
 * `source`. Used by the warm/cached module-record load path, where the
 * content-addressed cache stores compiled bodies but not their per-module
 * source maps: without a registered frame the ESM loader resolves `fn.src` to
 * the raw bundle coordinate (`<evalId>.js:..`), which the harness cannot
 * canonicalize, and CFC verified-source identity fails closed. An identity map
 * makes `mapPosition(<name>, line, col)` resolve to `<name>:line:col`, which
 * the engine then rewrites to the canonical `cf:module/<id>/<path>` form via
 * its per-module name → canonical table (parity with the source-compile path,
 * which carries a real authored map).
 *
 * Line/column coordinates are preserved verbatim (the compiled body IS the
 * eval'd text under this load), so no positional information is invented — the
 * map only re-labels the bundle coordinate with the per-module source name.
 */
export function identitySourceMap(body: string, source: string): SourceMap {
  const generator = new SourceMapGenerator({ file: source });
  const lineCount = (body.match(/\n/g)?.length ?? 0) + 1;
  for (let line = 1; line <= lineCount; line++) {
    generator.addMapping({
      generated: { line, column: 0 },
      original: { line, column: 0 },
      source,
    });
  }
  return JSON.parse(generator.toString()) as SourceMap;
}

/**
 * Maximum number of source maps to cache in memory.
 * When exceeded, oldest (least recently used) entries are evicted.
 *
 * Sized for the ESM module-record loader, which registers ONE map per load —
 * the composed `${loadId}.js` bundle map — PLUS one map per module (keyed by the
 * module's eval `//# sourceURL`) so the browser stack path can resolve each
 * module's eval frame. A single multi-file load therefore registers
 * `1 + moduleCount` entries that must all stay live until `loadModuleGraph`
 * annotates functions; a small cap (the old value was 50) would evict the bundle
 * map — and early per-module maps — mid-load for larger graphs, regressing
 * `fn.src` to raw bundle coordinates and breaking CFC verified-source identity.
 * This bound comfortably exceeds realistic per-load module counts while still
 * capping total memory across loads (stale maps from superseded loads evict via
 * LRU; the parser is also fully cleared on runtime dispose).
 */
const MAX_SOURCE_MAP_CACHE_SIZE = 1024;

// Parses strings like the following into function, filename, line and columns:
/// ```
// at doubleOrThrow (recipe-abc.js, <anonymous>:14:15)
// at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)
// at Object.errorOnLine6 [as default] (known-line.js, <anonymous>:5:15)
// at AMDLoader.resolveModule (recipe-abc.js, <anonymous>:1:1764)
// at AMDLoader.require (recipe-abc.js, <anonymous>:1:923)
// at eval (recipe-abc.js, <anonymous>:17:10)
// at async Scheduler.execute (http://localhost:8000/scripts/worker-runtime.js:241550:11)
// at GmailClient.googleRequest (somefile.js:24414:23)
/// ```
// Pattern breakdown:
// - Optional "async " prefix for async stack frames
// - Function name: [\w\.$<>]* allows alphanumeric, underscore, dot, $, and <> (for <anonymous>)
// - [as identifier]: \[as \w+\] matches any identifier, not just "factory"
const stackTracePattern =
  /at (?:async )?(.+?) (?:\[as [^\]]+\] )?\((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;
// V8 eval frames without a function name show the filename directly after "at".
// When there is a nested position in parens, it is the more precise location:
//   at recipe-abc.js, <anonymous>:14:15 (recipe-abc.js, <anonymous>:20:10)
//   at recipe-abc.js, <anonymous>:14:15
// The nested pattern matches the inner (more precise) position first.
const evalFrameNestedPattern =
  /at .+?, <anonymous>:\d+:\d+ \((.+?), <anonymous>:(\d+):(\d+)\)/;
const evalFramePattern = /at (.+?), <anonymous>:(\d+):(\d+)/;
const CF_INTERNAL = `    at <CF_INTERNAL>`;
const UNMAPPED = `    at <UNMAPPED>`;

export class SourceMapParser {
  private sourceMaps = new LRUCache<string, SourceMap>({
    capacity: MAX_SOURCE_MAP_CACHE_SIZE,
  });
  private consumers = new WeakMap<SourceMap, SourceMapConsumer>();

  load(filename: string, sourceMap: SourceMap) {
    this.sourceMaps.put(filename, sourceMap);
  }

  /**
   * Clear all accumulated source maps and consumers.
   * Used for cleanup when the runtime is disposed.
   */
  clear(): void {
    this.sourceMaps.clear();
  }

  // Fixes stack traces to use source map from eval. Strangely, both Deno and
  // Chrome at least only observe `sourceURL` but not the source map, so we can
  // use the former to find the right source map and then apply this.
  parse(stack: string): string {
    return stack.split("\n").map((line) => {
      const match = line.match(stackTracePattern);

      if (match) {
        return this.mapFrame(match[1], match[2], match[3], match[4], line);
      }

      // V8 eval frames without a function name.
      // Try the nested pattern first (inner position is more precise).
      const nestedMatch = line.match(evalFrameNestedPattern);
      if (nestedMatch) {
        return this.mapFrame(
          "",
          nestedMatch[1],
          nestedMatch[2],
          nestedMatch[3],
          line,
        );
      }

      const evalMatch = line.match(evalFramePattern);
      if (evalMatch) {
        return this.mapFrame(
          "",
          evalMatch[1],
          evalMatch[2],
          evalMatch[3],
          line,
        );
      }

      return line;
    }).join("\n");
  }

  private mapFrame(
    fnName: string,
    filename: string,
    lineStr: string,
    colStr: string,
    originalLine: string,
  ): string {
    const lineNum = parseInt(lineStr, 10);
    const columnNum = parseInt(colStr, 10);

    const sourceMap = this.sourceMaps.get(filename);
    if (!sourceMap) return originalLine;

    if (/AMDLoader/.test(fnName) && lineNum === 1) {
      return CF_INTERNAL;
    }

    const consumer = this.getConsumer(sourceMap);
    const originalPosition = consumer.originalPositionFor({
      line: lineNum,
      column: columnNum,
    });

    if (mapIsEmpty(originalPosition)) {
      if (fnName === "eval" || fnName === "") {
        return CF_INTERNAL;
      }
      return UNMAPPED;
    }

    const name = fnName || originalPosition.name || "<anonymous>";
    return `    at ${name} (${originalPosition.source}:${originalPosition.line}:${originalPosition.column})`;
  }

  // Map a single position to its original source location.
  // More efficient than parse() when you only need one position.
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    const sourceMap = this.sourceMaps.get(filename);
    if (!sourceMap) return null;
    const consumer = this.getConsumer(sourceMap);
    const pos = consumer.originalPositionFor({ line, column });
    return mapIsEmpty(pos) ? null : pos;
  }

  private getConsumer(sourceMap: SourceMap): SourceMapConsumer {
    let consumer = this.consumers.get(sourceMap);
    if (consumer) {
      return consumer;
    }
    consumer = new SourceMapConsumer(sourceMap);
    this.consumers.set(sourceMap, consumer);
    return consumer;
  }
}

function mapIsEmpty(position: MappedPosition): boolean {
  return position.source === null && position.name === null &&
    position.line === null && position.column === null;
}

export const isSourceMap = (value: unknown): value is SourceMap =>
  !!(value && typeof value === "object" &&
    "version" in value && value.version === "3" &&
    "file" in value && typeof value.file === "string" &&
    "sourceRoot" in value && typeof value.sourceRoot === "string" &&
    "sources" in value && Array.isArray(value.sources) &&
    "names" in value && Array.isArray(value.names) &&
    "mappings" in value && typeof value.mappings === "string");

// Parses string as a `SourceMap`, or throws if unable.
export function parseSourceMap(stringMap: string): SourceMap {
  const sourceMap = JSON.parse(stringMap);
  if (sourceMap && "version" in sourceMap) {
    // TypeScript correctly generates `version` as an integer,
    // but the `source-map-js` library's `RawSourceMap` we use
    // elsewhere expects `version` to be a string.
    sourceMap.version = `${sourceMap.version}`;
  }
  if (!isSourceMap(sourceMap)) {
    throw new Error(
      `Could not parse source map: ${JSON.stringify(sourceMap, null, 2)}`,
    );
  }
  return sourceMap;
}
