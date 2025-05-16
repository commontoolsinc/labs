import {
  RawSourceMap,
  SourceMapConsumer,
  SourceMapGenerator,
} from "source-map-js";
import { ExecutableJs, JsModule, SourceMap } from "../interface.ts";

class StringBuilder {
  private _out: string = "";
  private _lineCount: number = 0;

  push(str: string) {
    str = str.replace(/^\/\/# sourceMappingURL=.*$/m, "");
    this._out += str;
    this._lineCount += str.split("\n").length;
  }

  output(): string {
    return this._out;
  }

  lineCount(): number {
    return this._lineCount;
  }
}

// Concatenates JS strings, generating a source map,
// mapping to any existing source maps.
export class JsSourceConcat {
  private builder: StringBuilder = new StringBuilder();
  private map: SourceMapGenerator;

  constructor(outName: string) {
    this.map = new SourceMapGenerator({ file: outName });
  }

  // Push an unmapped string.
  push(lines: string) {
    this.builder.push(lines);
  }

  pushMapped(module: JsModule) {
    const lineCount = this.builder.lineCount();
    const { originalFilename, contents, sourceMap } = module;
    this.builder.push(contents);

    const consumer = new SourceMapConsumer(sourceMap);
    consumer.eachMapping((mapping) => {
      if (mapping.source === null) {
        return;
      }
      this.map.addMapping({
        generated: {
          line: lineCount + mapping.generatedLine,
          column: mapping.generatedColumn,
        },
        original: {
          line: mapping.originalLine ?? 0,
          column: mapping.originalColumn ?? 0,
        },
        source: mapping.source,
        name: mapping.name,
      });
    });
    if (consumer.sourcesContent) {
      for (let i = 0; i < consumer.sourcesContent.length; i++) {
        this.map.setSourceContent(
          consumer.sources[i],
          consumer.sourcesContent[i],
        );
      }
    }
  }

  render(
    { inlineSourceMaps, filename }: {
      inlineSourceMaps?: boolean;
      filename?: string;
    } = {},
  ): { sourceMap: SourceMap; js: string } {
    const sourceMap = JSON.parse(this.map.toString());
    let js = this.builder.output();

    if (inlineSourceMaps === true) {
      const encodedMap = btoa(JSON.stringify(sourceMap));
      // ${"sourceMappingURL"} prevents confusion with this file's source map
      js += `
//# ${"sourceMappingURL"}=data:application/json;base64,${encodedMap}
`;
    }

    if (filename) {
      // ${"sourceURL"} prevents confusion with this file's source map
      js += `
//# ${"sourceURL"}=${filename}
`;
    }

    return { js, sourceMap };
  }
}
