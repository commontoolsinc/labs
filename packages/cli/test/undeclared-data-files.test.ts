/**
 * `cf piece getsrc` writes a recovered source package to disk, and the files
 * it writes carry no record of which were data. A later `setsrc` re-derives
 * that from the source, so what it cannot re-derive is what getsrc has to say
 * out loud.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import { join } from "@std/path";
import {
  savePiecePattern,
  undeclaredDataFiles,
  undeclaredDataFileWarning,
} from "../lib/piece.ts";

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

describe("undeclaredDataFileWarning", () => {
  it("says nothing when the source accounts for every data file", () => {
    expect(
      undeclaredDataFileWarning(
        program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
          "/data/cities.json",
        ]),
      ),
    ).toBe(undefined);
  });

  it("spells out the flag that puts a file back on the next revision", () => {
    const warning = undeclaredDataFileWarning(
      program({ "/main.tsx": "export default 1;\n", "/extra.txt": "hi" }, [
        "/extra.txt",
      ]),
    );
    expect(warning).toContain("1 data file(s)");
    expect(warning).toContain("--datafile ./extra.txt");
    expect(warning).toContain("setsrc");
  });

  it("names every file it cannot account for", () => {
    const warning = undeclaredDataFileWarning(
      program({
        "/main.tsx": "export default 1;\n",
        "/a.txt": "a",
        "/b.txt": "b",
      }, ["/a.txt", "/b.txt"]),
    );
    expect(warning).toContain("2 data file(s)");
    expect(warning).toContain("--datafile ./a.txt");
    expect(warning).toContain("--datafile ./b.txt");
  });
});

describe("savePiecePattern", () => {
  const CONFIG = {
    apiUrl: "https://cf.dev",
    space: "common-knowledge",
    identity: "~/.my.key",
    piece: "p",
  };

  // The command reads one thing from the piece — its source program — and
  // writes what it finds. Everything else about a piece is beside the point.
  const piecesOver = (program: RuntimeProgram | undefined) => () =>
    Promise.resolve({
      get: () =>
        Promise.resolve({
          getPatternSourceProgram: () => Promise.resolve(program),
        }),
      // deno-lint-ignore no-explicit-any
    } as any);

  // Runs `body` with console.log captured, returning what it received.
  async function captureLog(body: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      await body();
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  it("writes every file the package holds, data included", async () => {
    const out = await Deno.makeTempDir({ prefix: "getsrc-" });
    try {
      await savePiecePattern(CONFIG, out, {
        loadPieces: piecesOver(
          program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
            "/data/cities.json",
          ]),
        ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
      });
      expect(await Deno.readTextFile(join(out, "main.tsx"))).toBe(READS_CITIES);
      expect(await Deno.readTextFile(join(out, "data/cities.json"))).toBe("[]");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("stays quiet when the source accounts for every data file", async () => {
    const out = await Deno.makeTempDir({ prefix: "getsrc-" });
    try {
      const logged = await captureLog(async () => {
        await savePiecePattern(CONFIG, out, {
          loadPieces: piecesOver(
            program({ "/main.tsx": READS_CITIES, "/data/cities.json": "[]" }, [
              "/data/cities.json",
            ]),
          ),
          resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        });
      });
      expect(logged).toBe("");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("names a data file the written source cannot re-derive", async () => {
    const out = await Deno.makeTempDir({ prefix: "getsrc-" });
    try {
      const logged = await captureLog(async () => {
        await savePiecePattern(CONFIG, out, {
          loadPieces: piecesOver(
            program({
              "/main.tsx": "export default 1;\n",
              "/extra.txt": "hi",
            }, ["/extra.txt"]),
          ),
          resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        });
      });
      expect(logged).toContain("--datafile ./extra.txt");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("refuses a piece that holds no pattern source", async () => {
    const out = await Deno.makeTempDir({ prefix: "getsrc-" });
    try {
      await expect(
        savePiecePattern(CONFIG, out, {
          loadPieces: piecesOver(undefined),
          resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        }),
      ).rejects.toThrow("does not contain a pattern source");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });
});
