import { SourceMap } from "./interface.ts";
import { MappedPosition, SourceMapConsumer } from "source-map-js";
import { LRUCache } from "@commontools/utils/cache";

export type { MappedPosition };

/**
 * Maximum number of source maps to cache in memory.
 * When exceeded, oldest (least recently used) entries are evicted.
 * Set conservatively to prevent OOM in long-running processes.
 */
const MAX_SOURCE_MAP_CACHE_SIZE = 50;

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
const CT_INTERNAL = `    at <CT_INTERNAL>`;
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
      return CT_INTERNAL;
    }

    const consumer = this.getConsumer(sourceMap);
    const originalPosition = consumer.originalPositionFor({
      line: lineNum,
      column: columnNum,
    });

    if (mapIsEmpty(originalPosition)) {
      if (fnName === "eval" || fnName === "") {
        return CT_INTERNAL;
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
