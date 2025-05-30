import { SourceMap } from "./interface.ts";
import { MappedPosition, SourceMapConsumer } from "source-map-js";

// Parses strings like the following into function, filename, line and columns:
/// ```
// at doubleOrThrow (recipe-abc.js, <anonymous>:14:15)
// at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)
// at AMDLoader.resolveModule (recipe-abc.js, <anonymous>:1:1764)
// at AMDLoader.require (recipe-abc.js, <anonymous>:1:923)
// at eval (recipe-abc.js, <anonymous>:17:10)
/// ```
const stackTracePattern =
  /at ([a-zA-Z\.]*) (?:\[as factory\] )?\((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;
const CT_INTERNAL = `    at <CT_INTERNAL>`;
const UNMAPPED = `    at <UNMAPPED>`;

export class SourceMapParser {
  private sourceMaps = new Map<string, SourceMap>();
  private consumers = new Map<string, SourceMapConsumer>();

  load(filename: string, sourceMap: SourceMap) {
    this.sourceMaps.set(filename, sourceMap);
  }

  // Fixes stack traces to use source map from eval. Strangely, both Deno and
  // Chrome at least only observe `sourceURL` but not the source map, so we can
  // use the former to find the right source map and then apply this.
  parse(stack: string): string {
    return stack.split("\n").map((line) => {
      const match = line.match(stackTracePattern);

      if (!match) {
        return line;
      }
      const fnName = match[1];
      const filename = match[2];
      const lineNum = parseInt(match[3], 10);
      const columnNum = parseInt(match[4], 10);

      if (!this.sourceMaps.has(filename)) return line;

      if (/AMDLoader/.test(fnName) && lineNum === 1) {
        return CT_INTERNAL;
      }

      const consumer = this.getConsumer(filename);
      const originalPosition = consumer.originalPositionFor({
        line: lineNum,
        column: columnNum,
      });

      if (mapIsEmpty(originalPosition)) {
        if (fnName === "eval") {
          return CT_INTERNAL;
        }
        return UNMAPPED;
      }

      // Replace the original line with the mapped position information
      return `    at ${fnName} (${originalPosition.source}:${originalPosition.line}:${originalPosition.column})`;
    }).join("\n");
  }

  private getConsumer(filename: string): SourceMapConsumer {
    if (!this.consumers.has(filename)) {
      this.consumers.set(
        filename,
        new SourceMapConsumer(this.sourceMaps.get(filename)!),
      );
    }

    return this.consumers.get(filename)!;
  }
}

function mapIsEmpty(position: MappedPosition): boolean {
  return position.source === null && position.name === null &&
    position.line === null && position.column === null;
}
