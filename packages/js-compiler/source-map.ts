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
  /at (?:async )?([\w\.$<>]*) (?:\[as \w+\] )?\((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;
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
  parse(stack: string, debug = false): string {
    // Always log loaded source maps for debugging
    console.log(
      "[source-map-debug] Loaded source maps:",
      [...this.sourceMaps.keys()],
    );
    if (debug) {
      logger.info(
        "source-map",
        `Loaded source maps: ${[...this.sourceMaps.keys()].join(", ")}`,
      );
    }
    return stack.split("\n").map((line) => {
      const match = line.match(stackTracePattern);

      if (!match) {
        if (debug) logger.info("source-map", `No regex match for: ${line}`);
        // Log non-matching lines that look like stack frames
        if (line.includes("at ")) {
          console.log("[source-map-debug] No regex match for:", line);
        }
        return line;
      }
      const fnName = match[1];
      const filename = match[2];
      const lineNum = parseInt(match[3], 10);
      const columnNum = parseInt(match[4], 10);

      console.log(
        "[source-map-debug] Matched:",
        { fnName, filename, lineNum, columnNum },
      );

      if (debug) {
        logger.info(
          "source-map",
          `Matched: fn=${fnName}, file=${filename}, line=${lineNum}, col=${columnNum}`,
        );
      }

      const sourceMap = this.sourceMaps.get(filename);
      if (!sourceMap) {
        console.log("[source-map-debug] No source map for:", filename);
        if (debug) logger.info("source-map", `No source map for: ${filename}`);
        return line;
      }

      if (/AMDLoader/.test(fnName) && lineNum === 1) {
        return CT_INTERNAL;
      }

      const consumer = this.getConsumer(sourceMap);
      const originalPosition = consumer.originalPositionFor({
        line: lineNum,
        column: columnNum,
      });

      if (mapIsEmpty(originalPosition)) {
        console.log("[source-map-debug] Empty mapping for:", {
          filename,
          lineNum,
          columnNum,
        });
        if (fnName === "eval") {
          return CT_INTERNAL;
        }
        return UNMAPPED;
      }

      console.log("[source-map-debug] Successfully mapped:", {
        from: { filename, lineNum, columnNum },
        to: originalPosition,
      });
      // Replace the original line with the mapped position information
      return `    at ${fnName} (${originalPosition.source}:${originalPosition.line}:${originalPosition.column})`;
    }).join("\n");
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
