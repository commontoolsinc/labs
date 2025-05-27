import { SourceMap } from "./interface.ts";
import { SourceMapConsumer } from "source-map-js";

const stackTracePattern =
  /at (?:[A-Z][a-zA-Z]+\.)?eval \((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;

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
    const lines = stack.split("\n");
    const mappedLines = lines.map((line) => {
      const match = line.match(stackTracePattern);

      if (match) {
        const fileName = match[1];
        const lineNum = parseInt(match[2], 10);
        const columnNum = parseInt(match[3], 10);

        if (!this.sourceMaps.has(fileName)) return line;

        if (!this.consumers.has(fileName)) {
          this.consumers.set(
            fileName,
            new SourceMapConsumer(this.sourceMaps.get(fileName)!),
          );
        }

        const consumer = this.consumers.get(fileName)!;
        const originalPosition = consumer.originalPositionFor({
          line: lineNum,
          column: columnNum,
        });
        console.log(
          "from " + JSON.stringify(originalPosition) + " to " +
            `${fileName}:${lineNum}:${columnNum}`,
        );

        // Replace the original line with the mapped position information
        return `    at ${originalPosition.source}:${originalPosition.line}:${originalPosition.column}`;
      } else {
        return line;
      }
    });

    return mappedLines.join("\n");
  }
}
