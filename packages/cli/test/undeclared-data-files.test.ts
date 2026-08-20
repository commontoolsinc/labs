/**
 * `cf piece getsrc` writes a recovered source package to disk, and the files
 * it writes carry no record of which were data. A later `setsrc` re-derives
 * that from the source, so what it cannot re-derive is what getsrc has to say
 * out loud.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import { undeclaredDataFiles } from "../lib/piece.ts";

const READS_CITIES = 'import { dataFile } from "commonfabric";\n' +
  'export default () => dataFile("/data/cities.json");\n';

function program(
  files: Record<string, string>,
  dataFiles?: string[],
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: Object.entries(files).map(([name, contents]) => ({
      name,
      contents,
    })),
    ...(dataFiles === undefined ? {} : { dataFiles }),
  };
}

describe("undeclaredDataFiles", () => {
  it("says nothing about a file the source reads by name", () => {
    expect(
      undeclaredDataFiles(
        program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
          "/data/cities.json",
        ]),
      ),
    ).toEqual([]);
  });

  it("names a file the source never reads", () => {
    expect(
      undeclaredDataFiles(
        program({ "/main.tsx": "export default 1;\n", "/extra.txt": "hi" }, [
          "/extra.txt",
        ]),
      ),
    ).toEqual(["/extra.txt"]);
  });

  it("names only the file the source cannot account for", () => {
    expect(
      undeclaredDataFiles(
        program({
          "/main.tsx": READS_CITIES,
          "/data/cities.json": "[]",
          "/extra.txt": "hi",
        }, ["/data/cities.json", "/extra.txt"]),
      ),
    ).toEqual(["/extra.txt"]);
  });

  it("says nothing about a program carrying no data at all", () => {
    expect(undeclaredDataFiles(program({ "/main.tsx": "export default 1;\n" })))
      .toEqual([]);
  });

  it("reads a declaration from any module of the program", () => {
    expect(
      undeclaredDataFiles(
        program({
          "/main.tsx": 'export { default } from "./reader.ts";\n',
          "/reader.ts": READS_CITIES,
          "/data/cities.json": "[]",
        }, ["/data/cities.json"]),
      ),
    ).toEqual([]);
  });
});
