import { expect } from "@std/expect";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  FileSystemProgramResolver,
  HttpProgramResolver,
  InMemoryProgram,
  readDataFileSource,
} from "../program.ts";

describe("InMemoryProgram", () => {
  it("resolves empty main and dependency sources", async () => {
    const resolver = new InMemoryProgram("/main.ts", {
      "/main.ts": "",
      "/dependency.ts": "",
    });

    expect(await resolver.main()).toEqual({
      name: "/main.ts",
      contents: "",
    });
    expect(await resolver.resolveSource("/dependency.ts")).toEqual({
      name: "/dependency.ts",
      contents: "",
    });
    expect(await resolver.resolveSource("/missing.ts")).toBeUndefined();
  });
});

describe("FileSystemProgramResolver", () => {
  it("keeps entry and dependency names grounded under filesystem root", async () => {
    const directory = await Deno.makeTempDir();
    const mainPath = `${directory}/main.ts`;
    const dependencyPath = `${directory}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(dependencyPath, "export default 2;");

    try {
      const resolver = new FileSystemProgramResolver(mainPath, directory);
      expect(await resolver.main()).toEqual({
        name: "/main.ts",
        contents: "export default 1;",
      });
      expect(await resolver.resolveSource("/dependency.ts")).toEqual({
        name: "/dependency.ts",
        contents: "export default 2;",
      });

      const filesystemRoot = path.parse(directory).root;
      const mainSpecifier = `/${
        path.relative(filesystemRoot, mainPath)
          .split(path.SEPARATOR).join("/")
      }`;
      const dependencySpecifier = `/${
        path.relative(filesystemRoot, dependencyPath)
          .split(path.SEPARATOR).join("/")
      }`;
      const rootResolver = new FileSystemProgramResolver(
        mainPath,
        filesystemRoot,
      );
      expect((await rootResolver.main()).name).toBe(mainSpecifier);
      expect(await rootResolver.resolveSource(dependencySpecifier)).toEqual({
        name: dependencySpecifier,
        contents: "export default 2;",
      });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("rejects a main path that only shares the root's text prefix", async () => {
    const root = await Deno.makeTempDir();
    try {
      expect(() =>
        new FileSystemProgramResolver(`${root}-sibling/main.ts`, root)
      ).toThrow("must be within root directory");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects entry and dependency symlinks that leave the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    const mainPath = `${root}/main.ts`;
    const outsideMainPath = `${outside}/main.ts`;
    const outsideDependencyPath = `${outside}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(outsideMainPath, "export default 2;");
    await Deno.writeTextFile(outsideDependencyPath, "export default 3;");
    await Deno.symlink(outsideMainPath, `${root}/linked-main.ts`, {
      type: "file",
    });
    await Deno.symlink(outsideDependencyPath, `${root}/dependency.ts`, {
      type: "file",
    });

    try {
      expect(() =>
        new FileSystemProgramResolver(`${root}/linked-main.ts`, root)
      ).toThrow("must be within root directory");

      const resolver = new FileSystemProgramResolver(mainPath, root);
      expect(() => resolver.resolveSource("/dependency.ts")).toThrow(
        "resolves outside of root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("retains logical names for symlinks whose targets remain inside the root", async () => {
    const root = await Deno.makeTempDir();
    const mainPath = `${root}/main.ts`;
    const dependencyPath = `${root}/dependency.ts`;
    await Deno.writeTextFile(mainPath, "export default 1;");
    await Deno.writeTextFile(dependencyPath, "export default 2;");
    await Deno.symlink(dependencyPath, `${root}/linked-dependency.ts`, {
      type: "file",
    });

    try {
      const resolver = new FileSystemProgramResolver(mainPath, root);
      expect(await resolver.resolveSource("/linked-dependency.ts")).toEqual({
        name: "/linked-dependency.ts",
        contents: "export default 2;",
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("readDataFileSource", () => {
  it("grounds a data file under the deployment root", async () => {
    const root = await Deno.makeTempDir();
    const dataDirectory = `${root}/data`;
    await Deno.mkdir(dataDirectory);
    await Deno.writeTextFile(`${dataDirectory}/cities.json`, '{"a": 1}');

    try {
      expect(readDataFileSource(`${dataDirectory}/cities.json`, root)).toEqual({
        name: "/data/cities.json",
        contents: '{"a": 1}',
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads bytes verbatim without treating them as TypeScript", async () => {
    const root = await Deno.makeTempDir();
    const contents = 'import x from "./nowhere.ts";\n\u00e9\t{ not code';
    await Deno.writeTextFile(`${root}/notes.txt`, contents);

    try {
      expect(readDataFileSource(`${root}/notes.txt`, root).contents).toBe(
        contents,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps a byte order mark in the contents", async () => {
    const root = await Deno.makeTempDir();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    await Deno.writeFile(`${root}/bom.json`, bytes);

    try {
      // The mark is part of the file, and a data file is stored byte-for-byte.
      expect(readDataFileSource(`${root}/bom.json`, root).contents).toBe(
        "\uFEFF{}",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects a data file outside the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    await Deno.writeTextFile(`${outside}/data.json`, "{}");

    try {
      expect(() => readDataFileSource(`${outside}/data.json`, root)).toThrow(
        "must be within root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("rejects a data file symlinked out of the root", async () => {
    const root = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    await Deno.writeTextFile(`${outside}/data.json`, "{}");
    await Deno.symlink(`${outside}/data.json`, `${root}/data.json`, {
      type: "file",
    });

    try {
      expect(() => readDataFileSource(`${root}/data.json`, root)).toThrow(
        "must be within root directory",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("rejects bytes that are not valid UTF-8 text", async () => {
    const root = await Deno.makeTempDir();
    await Deno.writeFile(`${root}/blob.bin`, new Uint8Array([0xc3, 0x28]));

    try {
      expect(() => readDataFileSource(`${root}/blob.bin`, root)).toThrow(
        "is not valid UTF-8 text",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("HttpProgramResolver", () => {
  it("invokes the default fetch with the host global as receiver", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    try {
      const resolver = new HttpProgramResolver(
        "https://patterns.example/main.ts",
      );
      expect(await resolver.main()).toEqual({
        name: "/main.ts",
        contents: "export default 42",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("invokes an injected fetch with the host global as receiver", async () => {
    const fetchImpl = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("export default 42"));
    } as typeof globalThis.fetch;

    const resolver = new HttpProgramResolver(
      "https://patterns.example/main.ts",
      fetchImpl,
    );
    expect(await resolver.main()).toEqual({
      name: "/main.ts",
      contents: "export default 42",
    });
  });
});
