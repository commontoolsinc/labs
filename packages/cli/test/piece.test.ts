import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  getCellOrThrow,
  ID as FABRIC_ID,
  isCell,
  isCellResult,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricSpecialObject } from "@commonfabric/data-model/fabric-value";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import {
  getCellValue,
  inspectPiece,
  listPieces,
  newPiece,
  PieceResultProjectionError,
  recreateSpaceRootPattern,
  resolveLinkEndpointAddress,
  resolvePieceConfig,
  searchPieces,
  setHomePattern,
  setPiecePattern,
  type SpaceConfig,
  withRuntimeCleanupOnFailure,
} from "../lib/piece.ts";
import { pieceId, SlugResolutionError } from "@commonfabric/piece";
import { setResultCell } from "../../runner/src/result-utils.ts";
import { toCell } from "../../runner/src/back-to-cell.ts";
import {
  formatPatternIdentity,
  formatPatternRef,
  localPatternEntry,
  normalizeApiUrl,
  parseLink,
  parsePieceOptions,
  parseSpaceOptions,
  piece,
  setPieceSourceFromCommand,
} from "../commands/piece.ts";

const API_URL = "https://cf.dev";
const SPACE = "common-knowledge";
const PIECE = "abcdefghijklmnopqrstuvwxyz";
const ID = "~/.my.key";
const FULL_URL = `${API_URL}/${SPACE}/${PIECE}`;
const NO_PIECE_FULL_URL = `${API_URL}/${SPACE}`;

describe("cli piece parsing", () => {
  it("formats structured pattern references for human output", () => {
    const identity = "A".repeat(43);
    const patternRef = {
      identity,
      symbol: "default",
      source: {
        ref: `cf:pattern:${identity}`,
        entry: "/notes/note.tsx",
      },
    };
    expect(formatPatternRef(patternRef)).toBe("/notes/note.tsx");
    expect(formatPatternIdentity(patternRef)).toBe(
      `cf:module/${identity}#default`,
    );
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: { ref: `cf:pattern:${identity}` },
    })).toBe(`cf:pattern:${identity}`);
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: {
        ref: `cf:pattern:${identity}`,
        repository: "https://github.com/commontoolsinc/labs",
        entry: "/packages/patterns/notes/note.tsx",
      },
    })).toBe(
      "https://github.com/commontoolsinc/labs#/packages/patterns/notes/note.tsx",
    );
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: {
        ref: `cf:pattern:${identity}`,
        origin: "cf:/did:key:z6Mk/example",
      },
    })).toBe("cf:/did:key:z6Mk/example");
    expect(formatPatternRef(undefined)).toBe("<unknown>");
  });

  it("normalizes API URLs for app route hints", () => {
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/base/",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/base",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/?debug=true#top",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net//base",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net//",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://user:pass@rapids.saga-castor.ts.net/",
    )).toBe("https://user:pass@rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://user:pass@rapids.saga-castor.ts.net/base/",
    )).toBe("https://user:pass@rapids.saga-castor.ts.net/base");
  });

  it("force-closes loadManager storage before disposing failed runtime", async () => {
    let disposeCalls = 0;
    let closeNowCalls = 0;
    const cleanupOrder: string[] = [];
    const originalError = new Error("sync failed");

    await expect(withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        cleanupOrder.push("dispose");
        return Promise.resolve();
      },
      storageManager: {
        closeNow: () => {
          closeNowCalls++;
          cleanupOrder.push("closeNow");
          return Promise.resolve();
        },
      },
    }, () => Promise.reject(originalError))).rejects.toBe(originalError);

    expect(closeNowCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(cleanupOrder).toEqual(["closeNow", "dispose"]);
  });

  it("still disposes failed runtime when force-close cleanup fails", async () => {
    let disposeCalls = 0;
    const originalError = new Error("sync failed");

    await expect(withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        return Promise.resolve();
      },
      storageManager: {
        closeNow: () => Promise.reject(new Error("closeNow failed")),
      },
    }, () => Promise.reject(originalError))).rejects.toBe(originalError);

    expect(disposeCalls).toBe(1);
  });

  it("does not dispose loadManager runtime after successful initialization", async () => {
    let disposeCalls = 0;

    const result = await withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        return Promise.resolve();
      },
    }, () => Promise.resolve("ready"));

    expect(result).toBe("ready");
    expect(disposeCalls).toBe(0);
  });

  it("parseSpaceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    };
    expect(parseSpaceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    })).toMatchObject(expected);
    const trailingApiUrl = parseSpaceOptions({
      apiUrl: `${API_URL}/`,
      space: SPACE,
      identity: ID,
    });
    expect(trailingApiUrl).toMatchObject(expected);
    expect(`${trailingApiUrl.apiUrl}/${trailingApiUrl.space}/${PIECE}`).toBe(
      FULL_URL,
    );
    expect(parseSpaceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: NO_PIECE_FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parseSpaceOptions() throws on incomplete input", () => {
    expect(() =>
      parseSpaceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        space: SPACE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        identity: ID,
      })
    ).toThrow(/--space/);
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parseSpaceOptions({
        identity: ID,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
      })
    ).toThrow();
  });

  it("parsePieceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    };
    expect(parsePieceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    })).toMatchObject(expected);
    expect(parsePieceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });

  it("parsePieceOptions() parses scope suffixes from piece ids and urls", () => {
    expect(parsePieceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: `${PIECE}@user`,
    })).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
      pieceScope: "user",
    });
    expect(parsePieceOptions({
      url: `${API_URL}/${SPACE}/${PIECE}@session`,
      identity: ID,
    })).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
      pieceScope: "session",
    });
  });
  it("parsePieceOptions() throws on incomplete input", () => {
    expect(() =>
      parsePieceOptions({
        url: NO_PIECE_FULL_URL,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        piece: PIECE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        identity: ID,
        piece: PIECE,
      })
    ).toThrow(/--space/);
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        identity: ID,
        piece: PIECE,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parsePieceOptions({
        identity: ID,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
        piece: PIECE,
      })
    ).toThrow();
  });

  it("recreateSpaceRootPattern() targets the explicit space", async () => {
    const seen: { config?: SpaceConfig; manager?: object } = {};
    const pieceId = await recreateSpaceRootPattern({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    }, {
      loadManager: (config) => {
        seen.config = config;
        const manager = {};
        seen.manager = manager;
        return Promise.resolve(manager as any);
      },
      createController: (manager) => {
        expect(manager).toBe(seen.manager);
        return {
          recreateDefaultPattern: () => Promise.resolve({ id: PIECE }),
        };
      },
    });

    expect(seen.config).toEqual({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    });
    expect(pieceId).toBe(PIECE);
  });

  it("shows recreate-root as a space-scoped command", async () => {
    const { code, stdout, stderr } = await cf("piece recreate-root --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(output).toContain(
      "Recreate the root pattern for the explicitly targeted space.",
    );
    expect(output).toContain("--space <space>");
    expect(code).toBe(0);
  });

  it("shows search as a space-scoped command with JSON output", async () => {
    const { code, stdout, stderr } = await cf("piece search --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(output).toContain(
      "Search readable input and result data in every piece.",
    );
    expect(output).toContain("<query>");
    expect(output).toContain("--space <space>");
    expect(output).toContain("--json");
    expect(code).toBe(0);
  });

  describe("parseLink", () => {
    it("should parse piece ID only", () => {
      const result = parseLink("piece1");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toBeUndefined();
    });

    it("should parse scope suffixes on the piece ID segment", () => {
      expect(parseLink("piece1@user")).toEqual({
        pieceId: "piece1",
        scope: "user",
      });
      expect(parseLink("piece1@session/path/0")).toEqual({
        pieceId: "piece1",
        scope: "session",
        path: ["path", 0],
      });
      expect(parseLink("piece1@space/path")).toEqual({
        pieceId: "piece1",
        scope: "space",
        path: ["path"],
      });
    });

    it("should reject invalid scope suffixes on the piece ID segment", () => {
      expect(() => parseLink("piece1@any")).toThrow(/Invalid scope suffix/);
      expect(() => parseLink("piece1@inherit")).toThrow(
        /Invalid scope suffix/,
      );
      expect(() => parseLink("piece1@")).toThrow(/Invalid scope suffix/);
    });

    it("should parse simple paths correctly", () => {
      const result = parseLink("piece1/field");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toEqual(["field"]);
    });

    it("should parse deep paths with array indices", () => {
      const result = parseLink("piece2/data/items/0/title");
      expect(result.pieceId).toBe("piece2");
      expect(result.path).toEqual(["data", "items", 0, "title"]);
    });

    it("should handle mixed string and numeric paths", () => {
      const result = parseLink("piece/users/5/profile/settings/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["users", 5, "profile", "settings", 2]);
    });

    it("should handle paths with only numbers", () => {
      const result = parseLink("piece/0/1/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual([0, 1, 2]);
    });

    it("should preserve @ in path segments after the piece ID", () => {
      const result = parseLink("piece/user@email");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["user@email"]);
      expect(result.scope).toBeUndefined();
    });

    it("should handle empty string after slash", () => {
      const result = parseLink("piece/field/");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["field", ""]);
    });
  });

  it("shows source-location options for every local deployment command", () => {
    const optionFlags = (command: string) =>
      piece.getCommand(command)!.getOptions().flatMap((option) => option.flags);
    const newFlags = optionFlags("new");
    expect(newFlags).toContain("--slug");
    expect(newFlags).toContain("--root");
    expect(newFlags).toContain("--repository");
    expect(newFlags).toContain("--dangerously-allow-incompatible-schema");

    for (const command of ["setsrc", "set-home"]) {
      const flags = optionFlags(command);
      expect(flags).toContain("--root");
      expect(flags).toContain("--repository");
    }
    expect(optionFlags("setsrc")).toContain(
      "--dangerously-allow-incompatible-schema",
    );
  });

  it("offers a one-session step option for piece result reads", () => {
    const getFlags = piece.getCommand("get")!.getOptions().flatMap((option) =>
      option.flags
    );
    expect(getFlags).toContain("--step");
  });

  it("steps, reads, syncs, and stops in one get operation", async () => {
    const order: string[] = [];
    const controller = {
      get: (
        id: string,
        runIt: boolean,
        _schema: unknown,
        scope: string | undefined,
      ) => {
        order.push(`get:${id}:${runIt}:${scope}`);
        return Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          getCell: () => ({
            pull: () => {
              order.push("piece.pull");
              return Promise.resolve();
            },
          }),
          result: {
            getCell: () =>
              Promise.resolve({
                key: (segment: string) => {
                  order.push(`result.key:${segment}`);
                  return {
                    pull: () => {
                      order.push("result.pull");
                      return Promise.resolve();
                    },
                  };
                },
              }),
            get: () => {
              order.push("result.get");
              return Promise.resolve("ready");
            },
          },
        });
      },
      stop: (id: string) => {
        order.push(`stop:${id}`);
        return Promise.resolve();
      },
    };
    const manager = {
      runtime: {
        idle: () => {
          order.push("runtime.idle");
          return Promise.resolve();
        },
      },
      synced: () => {
        order.push("manager.synced");
        return Promise.resolve();
      },
    };

    const value = await getCellValue(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
        piece: PIECE,
        pieceScope: "session",
      },
      ["value"],
      { step: true },
      {
        loadManager: () => Promise.resolve(manager as any),
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        createController: () => controller as any,
      },
    );

    expect(value).toBe("ready");
    expect(order).toEqual([
      `get:${PIECE}:true:session`,
      "piece.pull",
      "result.key:value",
      "result.pull",
      "manager.synced",
      "runtime.idle",
      "manager.synced",
      "result.get",
      `stop:${PIECE}`,
    ]);
  });

  it("reports schema projection failure when raw result data exists", async () => {
    const rawCell = {
      schema: { type: "object" },
      getRaw: () => ({ value: { "/": "missing-session-value" } }),
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    const error = await getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        loadManager: () => Promise.resolve({} as any),
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        createController: () => controller as any,
      },
    ).catch((error) => error);
    expect(error).toBeInstanceOf(PieceResultProjectionError);
    expect((error as Error).message).toContain("Use --step");
  });

  it("preserves undefined when no raw result data exists", async () => {
    const rawCell = {
      schema: { type: "object" },
      getRaw: () => undefined,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        loadManager: () => Promise.resolve({} as any),
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        createController: () => controller as any,
      },
    )).resolves.toBeUndefined();
  });

  it("reports a missing path backed by an unresolved raw link", async () => {
    const childCell = {
      schema: { type: "number" },
      getRaw: () => ({ "/": "missing-session-count" }),
    };
    const rootCell = {
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      getRaw: () => ({ count: { "/": "missing-session-count" } }),
      key: () => childCell,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () =>
              Promise.reject(
                new Error('Cannot access path "count" - property not found'),
              ),
            getCell: () => Promise.resolve(rootCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["count"],
      {},
      {
        loadManager: () => Promise.resolve({} as any),
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        createController: () => controller as any,
      },
    )).rejects.toThrow(PieceResultProjectionError);
  });

  it("preserves schema-valid undefined over present raw data", async () => {
    const rawCell = {
      schema: {
        anyOf: [{ type: "object" }, { type: "undefined" }],
      },
      getRaw: () => ({ "/": "optional-session-value" }),
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        loadManager: () => Promise.resolve({} as any),
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        createController: () => controller as any,
      },
    )).resolves.toBeUndefined();
  });

  it("rejects repository metadata when resetting the home pattern", async () => {
    const { piece: command } = await import(
      "../commands/piece.ts?repository-reset-test"
    );
    command.throwErrors();
    await expect(command.parse([
      "set-home",
      "--reset",
      "--repository",
      "https://github.com/commontoolsinc/labs",
    ])).rejects.toThrow("Cannot use --repository with --reset");
  });

  it("builds repository-aware entries from deployment flags", () => {
    expect(localPatternEntry("/repo/pattern.tsx", {
      mainExport: "named",
      repository: "https://github.com/commontoolsinc/labs",
      root: "/repo",
    })).toEqual({
      mainPath: "/repo/pattern.tsx",
      mainExport: "named",
      repository: "https://github.com/commontoolsinc/labs",
      rootPath: "/repo",
    });
  });

  it("forwards the dangerous override through setsrc command behavior", async () => {
    let forwarded: unknown;
    const pieceConfig = await setPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
        mainExport: "named",
        repository: "https://github.com/commontoolsinc/labs",
        root: "/repo",
        dangerouslyAllowIncompatibleSchema: true,
      },
      "/repo/pattern.tsx",
      {
        setPiecePattern: (config, entry, options) => {
          forwarded = { config, entry, options };
          return Promise.resolve();
        },
      },
    );

    expect(pieceConfig).toEqual({
      apiUrl: API_URL,
      space: SPACE,
      identity: "/tmp/test.key",
      piece: PIECE,
    });
    expect(forwarded).toEqual({
      config: pieceConfig,
      entry: {
        mainPath: "/repo/pattern.tsx",
        mainExport: "named",
        repository: "https://github.com/commontoolsinc/labs",
        rootPath: "/repo",
      },
      options: { dangerouslyAllowIncompatibleSchema: true },
    });
  });

  it("lists pattern provenance and isolates unreadable pieces", async () => {
    const patternRef = {
      identity: "A".repeat(43),
      symbol: "default",
      source: {
        ref: `cf:pattern:${"A".repeat(43)}`,
        repository: "https://github.com/commontoolsinc/labs",
        entry: "/notes/note.tsx",
      },
    };
    const controller = {
      getAllPieces: () =>
        Promise.resolve([
          { id: "of:readable" },
          { id: "of:unreadable" },
        ]),
      get: (id: string) =>
        id === "of:unreadable"
          ? Promise.reject(new Error("not readable"))
          : Promise.resolve({
            getCell: () => ({
              key: () => ({ pull: () => Promise.resolve("Readable") }),
            }),
            getPatternRef: () => Promise.resolve(patternRef),
          }),
    };

    const listed = await listPieces({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    }, {
      loadManager: () => Promise.resolve({} as any),
      createController: () => controller as any,
    });

    expect(listed).toEqual([
      { id: "of:readable", name: "Readable", patternRef },
      { id: "of:unreadable", error: "not readable" },
    ]);
  });

  it("searches nested input and result data without matching metadata", async () => {
    const patternRef = {
      identity: "S".repeat(43),
      symbol: "default",
      source: { ref: `cf:pattern:${"S".repeat(43)}` },
    };
    const cyclicInput: Record<string, unknown> = {
      nested: { message: "A NeEdLe in the input" },
    };
    cyclicInput.self = cyclicInput;
    class InternalObject {
      needleInternalField = "not piece data";
    }
    const fabricHash = new FabricHash(
      new Uint8Array([1, 2, 3, 4]),
      "fid1",
    );

    const searchablePiece = (
      id: string,
      name: string,
      input: unknown,
      result: unknown,
    ) => {
      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      return {
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(patternRef),
        input: { getCell: () => Promise.resolve(cell(input)) },
        result: { getCell: () => Promise.resolve(cell(result)) },
      };
    };
    const controller = {
      getAllPieces: () =>
        Promise.resolve([
          searchablePiece(
            "of:input-match",
            "Input match",
            cyclicInput,
            {},
          ),
          searchablePiece(
            "of:key-match",
            "Key match",
            {},
            { nested: { needleStatus: false } },
          ),
          searchablePiece(
            "of:needle-metadata-only",
            "Needle appears only in metadata",
            { content: "haystack" },
            { $NAME: "Needle appears only in metadata" },
          ),
          searchablePiece(
            "of:class-internals",
            "Class internals",
            new InternalObject(),
            {},
          ),
          searchablePiece(
            "of:internal-symbol",
            "Internal symbol metadata",
            { [FABRIC_ID]: "Needle in internal identity metadata" },
            {},
          ),
          searchablePiece(
            "of:fabric-special-object",
            "Fabric special object",
            new FabricError({
              type: "Error",
              name: "Error",
              message: "Needle in encoded Fabric data",
              stack: undefined,
              cause: undefined,
            }),
            {},
          ),
          searchablePiece(
            "of:fabric-hash",
            "Fabric hash",
            fabricHash,
            {},
          ),
        ]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadManager: () => Promise.resolve({} as any),
      createController: () => controller as any,
    };

    const matches = await searchPieces(config, "NEEDLE", deps);

    expect(matches).toEqual([
      { id: "of:input-match", name: "Input match", patternRef },
      { id: "of:key-match", name: "Key match", patternRef },
      {
        id: "of:fabric-special-object",
        name: "Fabric special object",
        patternRef,
      },
    ]);
    expect(await searchPieces(config, fabricHash.toString(), deps)).toEqual([{
      id: "of:fabric-hash",
      name: "Fabric hash",
      patternRef,
    }]);
  });

  it("searches scalar data and rejects an empty query", async () => {
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([{
          id: "of:number-match",
          name: () => "Number match",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(2048)) },
          result: { getCell: () => Promise.resolve(cell(null)) },
        }]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadManager: () => Promise.resolve({} as any),
      createController: () => controller as any,
    };

    expect(await searchPieces(config, "048", deps)).toEqual([{
      id: "of:number-match",
      name: "Number match",
      patternRef: undefined,
    }]);
    await expect(searchPieces(config, "", deps)).rejects.toThrow(
      "Search query must not be empty.",
    );
  });

  it("searches named array properties and skips result metadata", async () => {
    const input: unknown[] = ["ordinary array value"];
    Object.defineProperty(input, "annotation", {
      enumerable: true,
      value: "needle in a named array property",
    });
    const result: unknown[] = [];
    Object.defineProperty(result, "$NAME", {
      enumerable: true,
      value: "needle only in ignored result metadata",
    });
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([{
          id: "of:named-array-property",
          name: () => "Named array property",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(input)) },
          result: { getCell: () => Promise.resolve(cell(result)) },
        }]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadManager: () => Promise.resolve({} as any),
      createController: () => controller as any,
    };

    expect(
      await searchPieces(config, "named array property", deps),
    ).toEqual([{
      id: "of:named-array-property",
      name: "Named array property",
      patternRef: undefined,
    }]);
    expect(
      await searchPieces(config, "ignored result metadata", deps),
    ).toEqual([]);
  });

  it("reports unreadable iterators, cell proxies, and Fabric values", async () => {
    const iteratorError = new Error("array keys are not readable");
    const unreadableArray = new Proxy<unknown[]>([], {
      ownKeys: () => {
        throw iteratorError;
      },
    });
    const cellProxyError = new Error("cell proxy lost its backing cell");
    const unreadableCellProxy = {
      [toCell]: () => {
        throw cellProxyError;
      },
    };
    const stringError = new Error("Fabric string representation unavailable");
    class UnrepresentableFabricValue extends FabricSpecialObject {
      override toString(): string {
        throw stringError;
      }
    }
    const fabricValue = new UnrepresentableFabricValue();
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const piece = (id: string, input: unknown) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell(input)) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([
          piece("of:unreadable-array-iterator", unreadableArray),
          piece("of:unreadable-cell-proxy", unreadableCellProxy),
          piece("of:unrepresentable-fabric-value", fabricValue),
        ]),
    };
    const errors: unknown[] = [];

    expect(
      await searchPieces(
        { apiUrl: API_URL, space: SPACE, identity: ID },
        "absent search value",
        {
          loadManager: () => Promise.resolve({} as any),
          createController: () => controller as any,
          reportSearchError: (_pieceId, _source, error) => errors.push(error),
        },
      ),
    ).toEqual([]);
    expect(errors).toContain(iteratorError);
    expect(errors).toContain(cellProxyError);
    expect(errors).toContain(stringError);
    expect(errors.map(String).some((error) => error.includes("no `[CODEC]`")))
      .toBe(true);
  });

  it("warns when input and result data cannot be read", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      const controller = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:unreadable-data",
            name: () => "Unreadable data",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.reject(new Error("input unavailable")),
            },
            result: {
              getCell: () => Promise.reject("result unavailable"),
            },
          }]),
      };

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "needle",
          {
            loadManager: () => Promise.resolve({} as any),
            createController: () => controller as any,
          },
        ),
      ).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      "Warning: Could not read input data for piece of:unreadable-data: input unavailable",
      "Warning: Could not read result data for piece of:unreadable-data: result unavailable",
    ]);
  });

  it("returns a match when its metadata cannot be read", async () => {
    const nameError = new Error("piece name unavailable");
    const patternError = new Error("pattern reference unavailable");
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([{
          id: "of:unreadable-metadata",
          name: () => {
            throw nameError;
          },
          getPatternRef: () => Promise.reject(patternError),
          input: { getCell: () => Promise.resolve(cell("needle")) },
          result: { getCell: () => Promise.resolve(cell({})) },
        }]),
    };
    const errors: Array<{ source: string; error: unknown }> = [];

    expect(
      await searchPieces(
        { apiUrl: API_URL, space: SPACE, identity: ID },
        "needle",
        {
          loadManager: () => Promise.resolve({} as any),
          createController: () => controller as any,
          reportSearchError: (_pieceId, source, error) =>
            errors.push({ source, error }),
        },
      ),
    ).toEqual([{
      id: "of:unreadable-metadata",
      name: undefined,
      patternRef: undefined,
    }]);
    expect(errors).toEqual([
      { source: "metadata", error: nameError },
      { source: "metadata", error: patternError },
    ]);
  });

  it("uses full Unicode case folding and canonical normalization", async () => {
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const piece = (id: string, input: unknown) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell(input)) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([
          piece("of:full-fold", "Maße"),
          piece("of:canonical-equivalence", "café"),
          piece("of:indic-substring", "क्ष"),
          piece("of:unicode-17", "\u{16EA0}"),
          piece("of:unrelated", "needle"),
        ]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadManager: () => Promise.resolve({} as any),
      createController: () => controller as any,
    };

    expect(await searchPieces(config, "MASSE", deps)).toEqual([{
      id: "of:full-fold",
      name: "of:full-fold",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "CAFE\u0301", deps)).toEqual([{
      id: "of:canonical-equivalence",
      name: "of:canonical-equivalence",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "\u{16EBB}", deps)).toEqual([{
      id: "of:unicode-17",
      name: "of:unicode-17",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "ष", deps)).toEqual([{
      id: "of:indic-substring",
      name: "of:indic-substring",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "s", deps)).toEqual([]);
    expect(await searchPieces(config, "CAFE", deps)).toEqual([]);
  });

  it("materializes nested runtime cells without searching cell internals", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search nested cell test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const nestedSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const inputSchema = {
        type: "object",
        properties: {
          nested: { ...nestedSchema, asCell: ["cell"] },
          hidden: { ...nestedSchema, asCell: ["opaque"] },
        },
        required: ["nested", "hidden"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const nested = runtime.getCell(
        space,
        "piece-search-nested-visible",
        nestedSchema,
        tx,
      );
      nested.set({ text: "needle in a nested runtime cell" });
      const hidden = runtime.getCell(
        space,
        "piece-search-nested-hidden",
        nestedSchema,
        tx,
      );
      hidden.set({ text: "opaque-search-secret" });
      const input = runtime.getCell(
        space,
        "piece-search-input",
        inputSchema,
        tx,
      );
      input.set({ nested, hidden });
      const result = runtime.getCell(
        space,
        "piece-search-result",
        undefined,
        tx,
      );
      result.set({ $NAME: "needle only in the piece name" });
      await tx.commit();
      await runtime.idle();

      const inputValue = await input.pull();
      expect(isCell(inputValue.nested)).toBe(true);
      if (!isCell(inputValue.nested)) {
        throw new Error("Expected nested input data to remain a Cell");
      }
      expect(await inputValue.nested.pull()).toEqual({
        text: "needle in a nested runtime cell",
      });

      const controller = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:runtime-cell-piece",
            name: () => "needle only in the piece name",
            getPatternRef: () => Promise.resolve(undefined),
            input: { getCell: () => Promise.resolve(input) },
            result: { getCell: () => Promise.resolve(result) },
          }]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadManager: () => Promise.resolve({} as any),
        createController: () => controller as any,
      };

      expect(await searchPieces(config, "nested runtime", deps)).toEqual([{
        id: "of:runtime-cell-piece",
        name: "needle only in the piece name",
        patternRef: undefined,
      }]);
      expect(await searchPieces(config, "opaque-search-secret", deps)).toEqual(
        [],
      );
      expect(await searchPieces(config, "_link", deps)).toEqual([]);
      expect(await searchPieces(config, "unique to the context", deps))
        .toEqual([]);
      expect(await searchPieces(config, "piece name", deps)).toEqual([]);

      const narrowView = runtime.getCell(
        space,
        "piece-search-nested-visible",
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      );
      const wideView = runtime.getCell(
        space,
        "piece-search-nested-visible",
        nestedSchema,
      );
      const viewController = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:multiple-runtime-cell-views",
            name: () => "Multiple runtime cell views",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve({
                  pull: () => Promise.resolve([narrowView, wideView]),
                }),
            },
            result: {
              getCell: () =>
                Promise.resolve({ pull: () => Promise.resolve({}) }),
            },
          }]),
      };
      expect(
        await searchPieces(config, "nested runtime cell", {
          loadManager: () => Promise.resolve({} as any),
          createController: () => viewController as any,
        }),
      ).toEqual([{
        id: "of:multiple-runtime-cell-views",
        name: "Multiple runtime cell views",
        patternRef: undefined,
      }]);

      const brokenNested = runtime.getCell(
        space,
        "piece-search-broken-nested",
        nestedSchema,
      );
      Object.defineProperty(brokenNested, "pull", {
        value: () => Promise.reject(new Error("nested cell unavailable")),
      });
      const nestedErrors: unknown[] = [];
      const partialController = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:partial-runtime-cell-piece",
            name: () => "Partial runtime cell piece",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve({
                  pull: () =>
                    Promise.resolve([
                      brokenNested,
                      "surviving nested cell data",
                    ]),
                }),
            },
            result: {
              getCell: () =>
                Promise.resolve({ pull: () => Promise.resolve({}) }),
            },
          }]),
      };
      expect(
        await searchPieces(config, "surviving nested", {
          loadManager: () => Promise.resolve({} as any),
          createController: () => partialController as any,
          reportSearchError: (_pieceId, _source, error) =>
            nestedErrors.push(error),
        }),
      ).toEqual([{
        id: "of:partial-runtime-cell-piece",
        name: "Partial runtime cell piece",
        patternRef: undefined,
      }]);
      expect(nestedErrors).toEqual([new Error("nested cell unavailable")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("attributes linked data to its owner and preserves ownerless data", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search linked cell owner test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const sharedSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const scalarSchema = { type: "string" } as const;
      const emptySchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const;
      const inputSchema = {
        type: "object",
        properties: {
          sharedCell: { ...sharedSchema, asCell: ["cell"] },
          sharedValue: sharedSchema,
          sharedScalar: scalarSchema,
          ownerlessCell: { ...sharedSchema, asCell: ["cell"] },
          ownerlessValue: sharedSchema,
          unregisteredPieceValue: sharedSchema,
          unregisteredKeylessValue: sharedSchema,
        },
        required: [
          "sharedCell",
          "sharedValue",
          "sharedScalar",
          "ownerlessCell",
          "ownerlessValue",
          "unregisteredPieceValue",
          "unregisteredKeylessValue",
        ],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const sharedCell = runtime.getCell(
        space,
        "piece-search-owned-cell-data",
        sharedSchema,
        tx,
      );
      const sharedValue = runtime.getCell(
        space,
        "piece-search-owned-proxy-data",
        sharedSchema,
        tx,
      );
      const sharedScalar = runtime.getCell(
        space,
        "piece-search-owned-scalar-data",
        scalarSchema,
        tx,
      );
      const ownerlessCell = runtime.getCell(
        space,
        "piece-search-ownerless-cell-data",
        sharedSchema,
        tx,
      );
      const ownerlessValue = runtime.getCell(
        space,
        "piece-search-ownerless-proxy-data",
        sharedSchema,
        tx,
      );
      const unregisteredPieceValue = runtime.getCell(
        space,
        "piece-search-unregistered-piece-data",
        sharedSchema,
        tx,
      );
      const unregisteredKeylessValue = runtime.getCell(
        space,
        "piece-search-unregistered-keyless-data",
        sharedSchema,
        tx,
      );
      const unregisteredKeylessArgument = runtime.getCell(
        space,
        "piece-search-unregistered-keyless-argument",
        emptySchema,
        tx,
      );
      const ownerResult = runtime.getCell(
        space,
        "piece-search-owner-result",
        emptySchema,
        tx,
      );
      const ownerInput = runtime.getCell(
        space,
        "piece-search-owner-input",
        inputSchema,
        tx,
      );
      const referrerResult = runtime.getCell(
        space,
        "piece-search-referrer-result",
        emptySchema,
        tx,
      );
      const referrerInput = runtime.getCell(
        space,
        "piece-search-referrer-input",
        inputSchema,
        tx,
      );
      const aliasInput = runtime.getCell(
        space,
        "piece-search-alias-input",
        emptySchema,
        tx,
      );
      const aliasResult = runtime.getCell(
        space,
        "piece-search-alias-result",
        sharedSchema,
        tx,
      );

      sharedCell.set({ text: "explicit ownership match" });
      sharedValue.set({ text: "proxy ownership match" });
      sharedScalar.set("scalar ownership match");
      ownerlessCell.set({ text: "ownerless explicit match" });
      ownerlessValue.set({ text: "ownerless proxy match" });
      unregisteredPieceValue.set({ text: "unregistered piece match" });
      unregisteredPieceValue.setMetaRaw("patternIdentity", {
        identity: "P".repeat(43),
        symbol: "default",
      });
      unregisteredKeylessValue.set({ text: "unregistered keyless match" });
      unregisteredKeylessArgument.set({});
      unregisteredKeylessValue.setMetaRaw(
        "argument",
        unregisteredKeylessArgument.getAsWriteRedirectLink(),
      );
      ownerResult.set({});
      ownerInput.set({
        sharedCell,
        sharedValue,
        sharedScalar,
        ownerlessCell,
        ownerlessValue,
        unregisteredPieceValue,
        unregisteredKeylessValue,
      });
      referrerResult.set({});
      referrerInput.set({
        sharedCell,
        sharedValue,
        sharedScalar,
        ownerlessCell,
        ownerlessValue,
        unregisteredPieceValue,
        unregisteredKeylessValue,
      });
      aliasInput.set({});
      aliasResult.set(sharedValue);
      setResultCell(sharedCell, ownerResult);
      setResultCell(sharedValue, ownerResult);
      setResultCell(sharedScalar, ownerResult);
      setResultCell(ownerInput, ownerResult);
      setResultCell(ownerResult, referrerResult);
      setResultCell(referrerInput, referrerResult);
      setResultCell(aliasInput, aliasResult);
      await tx.commit();
      await runtime.idle();

      const referrerInputValue = await referrerInput.pull();
      expect(isCell(referrerInputValue.sharedCell)).toBe(true);
      expect(isCellResult(referrerInputValue.sharedValue)).toBe(true);
      expect(referrerInputValue.sharedScalar).toBe("scalar ownership match");
      expect(isCell(referrerInputValue.ownerlessCell)).toBe(true);
      expect(isCellResult(referrerInputValue.ownerlessValue)).toBe(true);
      expect(isCellResult(referrerInputValue.unregisteredPieceValue)).toBe(
        true,
      );
      expect(isCellResult(referrerInputValue.unregisteredKeylessValue)).toBe(
        true,
      );
      const linkedValueCell = getCellOrThrow(referrerInputValue.sharedValue);
      expect(pieceId(linkedValueCell)).toBe(pieceId(referrerInput));
      expect(pieceId(linkedValueCell.resolveAsCell())).toBe(
        pieceId(sharedValue),
      );

      const ownerId = pieceId(ownerResult);
      const referrerId = pieceId(referrerResult);
      const aliasId = pieceId(aliasResult);
      if (
        ownerId === undefined || referrerId === undefined ||
        aliasId === undefined
      ) {
        throw new Error("Expected result cells to have piece IDs");
      }
      const piece = (
        id: string,
        name: string,
        input: Cell<unknown>,
        result: Cell<unknown>,
      ) => ({
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(undefined),
        input: { getCell: () => Promise.resolve(input) },
        result: { getCell: () => Promise.resolve(result) },
      });
      const controller = {
        getAllPieces: () =>
          Promise.resolve([
            piece(referrerId, "Referrer", referrerInput, referrerResult),
            piece(aliasId, "Top-level alias", aliasInput, aliasResult),
            piece(ownerId, "Owner", ownerInput, ownerResult),
          ]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadManager: () => Promise.resolve({} as any),
        createController: () => controller as any,
      };

      expect(
        await searchPieces(config, "explicit ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(
        await searchPieces(config, "proxy ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(
        await searchPieces(config, "scalar ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      const referrerAndOwner = [
        { id: referrerId, name: "Referrer", patternRef: undefined },
        { id: ownerId, name: "Owner", patternRef: undefined },
      ];
      expect(
        await searchPieces(config, "ownerless explicit", deps),
      ).toEqual(referrerAndOwner);
      expect(
        await searchPieces(config, "ownerless proxy", deps),
      ).toEqual(referrerAndOwner);
      expect(
        await searchPieces(config, "unregistered piece", deps),
      ).toEqual([]);
      expect(
        await searchPieces(config, "unregistered keyless", deps),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("deduplicates cells and rejects values whose owner cannot be read", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search traversal edge coverage test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const textSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const emptySchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const;
      const rootSchema = {
        type: "object",
        properties: { field: { type: "string" } },
        required: ["field"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const repeatedCell = runtime.getCell(
        space,
        "piece-search-repeated-cell",
        textSchema,
        tx,
      );
      repeatedCell.set({ text: "repeated cell haystack" });
      const repeatedProxySource = runtime.getCell(
        space,
        "piece-search-repeated-proxy",
        textSchema,
        tx,
      );
      repeatedProxySource.set({ text: "repeated proxy haystack" });
      const ownedProxySource = runtime.getCell(
        space,
        "piece-search-owned-proxy-coverage",
        textSchema,
        tx,
      );
      ownedProxySource.set({ text: "owned proxy coverage needle" });
      const ownerResult = runtime.getCell(
        space,
        "piece-search-owner-result-coverage",
        emptySchema,
        tx,
      );
      ownerResult.set({});
      setResultCell(ownedProxySource, ownerResult);

      const brokenRoot = runtime.getCell(
        space,
        "piece-search-broken-source-root",
        rootSchema,
        tx,
      );
      brokenRoot.set({ field: "unreachable source value" });
      const brokenSource = runtime.getCell(
        space,
        "piece-search-broken-source-child",
        { type: "string" },
        tx,
      );
      brokenSource.set("unreachable source value");
      await tx.commit();
      await runtime.idle();

      const sourceError = new Error("source ownership unavailable");
      const brokenSourceView = new Proxy(brokenSource, {
        get(target, property) {
          if (property === "resolveAsCell") {
            return () => {
              throw sourceError;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const brokenRootView = new Proxy(brokenRoot, {
        get(target, property) {
          if (property === "key") {
            return () => brokenSourceView;
          }
          if (property === "pull") {
            return () => Promise.resolve({ field: "unreachable source value" });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const ownerId = pieceId(ownerResult);
      if (ownerId === undefined) {
        throw new Error("Expected the owner result to have a piece ID");
      }
      const repeatedProxy = repeatedProxySource.getAsQueryResult();
      const ownedProxy = ownedProxySource.getAsQueryResult();
      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const piece = (id: string, name: string, input: unknown) => ({
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(undefined),
        input: { getCell: () => Promise.resolve(cell(input)) },
        result: { getCell: () => Promise.resolve(cell({})) },
      });
      const controller = {
        getAllPieces: () =>
          Promise.resolve([
            piece("of:owned-proxy-referrer", "Referrer", [ownedProxy]),
            piece(ownerId, "Owner", "owned proxy coverage needle"),
            piece("of:repeated-cell", "Repeated cell", [
              repeatedCell,
              repeatedCell,
            ]),
            piece("of:repeated-proxy", "Repeated proxy", [
              repeatedProxy,
              repeatedProxy,
            ]),
            {
              id: "of:broken-source-owner",
              name: () => "Broken source owner",
              getPatternRef: () => Promise.resolve(undefined),
              input: { getCell: () => Promise.resolve(brokenRootView) },
              result: { getCell: () => Promise.resolve(cell({})) },
            },
          ]),
      };
      const errors: Array<{
        pieceId: string;
        source: "input data" | "result data" | "metadata";
        error: unknown;
      }> = [];

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "owned proxy coverage needle",
          {
            loadManager: () => Promise.resolve({} as any),
            createController: () => controller as any,
            reportSearchError: (pieceId, source, error) =>
              errors.push({ pieceId, source, error }),
          },
        ),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.every(({ pieceId, source, error }) =>
          pieceId === "of:broken-source-owner" && source === "input data" &&
          error === sourceError
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports cyclic Cell ownership without attributing the data", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search cyclic cell owner test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const schema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const first = runtime.getCell(
        space,
        "piece-search-owner-cycle-first",
        schema,
        tx,
      );
      const second = runtime.getCell(
        space,
        "piece-search-owner-cycle-second",
        schema,
        tx,
      );
      first.set({ text: "cyclic ownership match" });
      second.set({ text: "other cycle value" });
      setResultCell(first, second);
      setResultCell(second, first);
      await tx.commit();
      await runtime.idle();

      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const controller = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:cycle-referrer",
            name: () => "Cycle referrer",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell({ linked: first })),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          }]),
      };
      const errors: unknown[] = [];

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "cyclic ownership",
          {
            loadManager: () => Promise.resolve({} as any),
            createController: () => controller as any,
            reportSearchError: (_pieceId, _source, error) => errors.push(error),
          },
        ),
      ).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain(
        "Cycle found while resolving piece ownership",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("loads nested cells from a cold runtime before searching them", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search cold runtime test",
    );
    const space = signer.did();
    const audience = "did:key:z6Mk-runner-emulated-memory";
    const server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience },
    });

    class SharedStorage extends EmulatedStorageManager {
      static connect(server: MemoryV2Server.Server): SharedStorage {
        const manager = new SharedStorage(
          { as: signer, memoryHost: new URL("memory://") } as any,
          () => server,
        );
        manager.#server = server;
        return manager;
      }

      #server!: MemoryV2Server.Server;

      protected override server(): MemoryV2Server.Server {
        return this.#server;
      }
    }

    const leafSchema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    } as const satisfies JSONSchema;
    const middleSchema = {
      type: "object",
      properties: { leaf: { ...leafSchema, asCell: ["cell"] } },
      required: ["leaf"],
    } as const satisfies JSONSchema;
    const rootSchema = {
      type: "object",
      properties: { middle: { ...middleSchema, asCell: ["cell"] } },
      required: ["middle"],
    } as const satisfies JSONSchema;
    const writerStorage = SharedStorage.connect(server);
    const writer = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: writerStorage,
    });
    const writeTx = writer.edit();
    const leaf = writer.getCell(
      space,
      "piece-search-cold-leaf",
      leafSchema,
      writeTx,
    );
    const middle = writer.getCell(
      space,
      "piece-search-cold-middle",
      middleSchema,
      writeTx,
    );
    const root = writer.getCell(
      space,
      "piece-search-cold-root",
      rootSchema,
      writeTx,
    );
    leaf.set({ text: "cold-cache-needle" });
    middle.set({ leaf });
    root.set({ middle });
    await writeTx.commit();
    await writerStorage.synced();

    const readerStorage = SharedStorage.connect(server);
    const reader = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: readerStorage,
    });
    try {
      const readerRoot = reader.getCell(
        space,
        "piece-search-cold-root",
        rootSchema,
      );
      const empty = reader.getCell(space, "piece-search-cold-empty", true);
      const controller = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:cold-runtime-piece",
            name: () => "Cold runtime piece",
            getPatternRef: () => Promise.resolve(undefined),
            input: { getCell: () => Promise.resolve(readerRoot) },
            result: { getCell: () => Promise.resolve(empty) },
          }]),
      };

      expect(
        await searchPieces(
          {
            apiUrl: API_URL,
            space: SPACE,
            identity: ID,
          },
          "cold-cache-needle",
          {
            loadManager: () => Promise.resolve({} as any),
            createController: () => controller as any,
          },
        ),
      ).toEqual([{
        id: "of:cold-runtime-piece",
        name: "Cold runtime piece",
        patternRef: undefined,
      }]);
    } finally {
      await reader.dispose();
      await readerStorage.close();
      await writer.dispose();
      await writerStorage.close();
      await server.close();
    }
  });

  it("searches arrays with a large sparse length", async () => {
    const values: unknown[] = [];
    values.length = 0xffff_ffff;
    values[0xffff_fffe] = "large-array-needle";
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([{
          id: "of:large-array",
          name: () => "Large array",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(values)) },
          result: { getCell: () => Promise.resolve(cell({})) },
        }]),
    };

    expect(
      await searchPieces(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: ID,
        },
        "large-array-needle",
        {
          loadManager: () => Promise.resolve({} as any),
          createController: () => controller as any,
        },
      ),
    ).toEqual([{
      id: "of:large-array",
      name: "Large array",
      patternRef: undefined,
    }]);
  });

  it("searches current data after a query proxy changes shape", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search stale array proxy test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const tx = runtime.edit();
      const arrayToObjectSource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-array-to-object-proxy",
        undefined,
        tx,
      );
      arrayToObjectSource.set(["old array value"]);
      const arrayToObjectProxy = arrayToObjectSource.getAsQueryResult();
      arrayToObjectSource.set({
        changedShape: "shape-change-value",
        length: "hidden-length-value",
      });

      const arrayToScalarSource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-array-to-scalar-proxy",
        undefined,
        tx,
      );
      arrayToScalarSource.set(["other old array value"]);
      const arrayToScalarProxy = arrayToScalarSource.getAsQueryResult();
      arrayToScalarSource.set("scalar-shape-value");

      const objectToArraySource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-object-to-array-proxy",
        undefined,
        tx,
      );
      objectToArraySource.set({ oldObjectValue: true });
      const objectToArrayProxy = objectToArraySource.getAsQueryResult();
      objectToArraySource.set(["array-shape-value"]);
      await tx.commit();
      await runtime.idle();

      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const controller = {
        getAllPieces: () =>
          Promise.resolve([{
            id: "of:stale-array-proxy",
            name: () => "Stale array proxy",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve(cell({
                  arrayToObject: arrayToObjectProxy,
                  arrayToScalar: arrayToScalarProxy,
                  objectToArray: objectToArrayProxy,
                })),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          }]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadManager: () => Promise.resolve({} as any),
        createController: () => controller as any,
      };
      const match = [{
        id: "of:stale-array-proxy",
        name: "Stale array proxy",
        patternRef: undefined,
      }];

      expect(
        await searchPieces(config, "changedShape", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "shape-change-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "hidden-length-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "scalar-shape-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "array-shape-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "0", deps),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("continues after an unreadable piece and preserves match order", async () => {
    const errors: Array<{
      pieceId: string;
      source: "input data" | "result data" | "metadata";
      error: unknown;
    }> = [];
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const matchingPiece = (id: string) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell("needle")) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const partiallyReadableObject = {
      get broken(): unknown {
        throw new Error("object property not readable");
      },
      survives: "needle after unreadable object property",
    };
    const partiallyReadableArray = [undefined, "needle after unreadable array"];
    Object.defineProperty(partiallyReadableArray, 0, {
      enumerable: true,
      get: () => {
        throw new Error("array element not readable");
      },
    });
    const controller = {
      getAllPieces: () =>
        Promise.resolve([
          matchingPiece("of:first-match"),
          {
            id: "of:unreadable",
            name: () => "Result-only match",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.reject(new Error("not readable")),
            },
            result: { getCell: () => Promise.resolve(cell("needle")) },
          },
          {
            id: "of:partial-object",
            name: () => "Partial object",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell(partiallyReadableObject)),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          },
          {
            id: "of:partial-array",
            name: () => "Partial array",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell(partiallyReadableArray)),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          },
          matchingPiece("of:second-match"),
        ]),
    };

    expect(
      await searchPieces(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: ID,
        },
        "needle",
        {
          loadManager: () => Promise.resolve({} as any),
          createController: () => controller as any,
          reportSearchError: (pieceId, source, error) =>
            errors.push({ pieceId, source, error }),
        },
      ),
    ).toEqual([
      {
        id: "of:first-match",
        name: "of:first-match",
        patternRef: undefined,
      },
      {
        id: "of:unreadable",
        name: "Result-only match",
        patternRef: undefined,
      },
      {
        id: "of:partial-object",
        name: "Partial object",
        patternRef: undefined,
      },
      {
        id: "of:partial-array",
        name: "Partial array",
        patternRef: undefined,
      },
      {
        id: "of:second-match",
        name: "of:second-match",
        patternRef: undefined,
      },
    ]);
    expect(errors).toHaveLength(3);
    expect(errors).toContainEqual({
      pieceId: "of:unreadable",
      source: "input data",
      error: new Error("not readable"),
    });
    expect(errors).toContainEqual({
      pieceId: "of:partial-object",
      source: "input data",
      error: new Error("object property not readable"),
    });
    expect(errors).toContainEqual({
      pieceId: "of:partial-array",
      source: "input data",
      error: new Error("array element not readable"),
    });
  });

  it("forwards repository metadata through piece creation and updates", async () => {
    const repository = "https://github.com/commontoolsinc/labs";
    const entry = { mainPath: "/repo/main.tsx", repository };
    const program = {} as any;
    const manager = {
      add: () => Promise.resolve(),
    };
    let createOptions: unknown;
    let setPatternOptions: unknown;
    const createdPiece = { id: PIECE, getCell: () => ({} as any) };

    const createdId = await newPiece(
      { apiUrl: API_URL, space: SPACE, identity: ID },
      entry,
      { start: false },
      {
        loadManager: () => Promise.resolve(manager as any),
        createController: () => ({
          ensureDefaultPattern: () => Promise.resolve({}),
          create: (_program: unknown, options: unknown) => {
            createOptions = options;
            return Promise.resolve(createdPiece);
          },
        } as any),
        getPinnedProgramFromFile: () => Promise.resolve(program),
      },
    );
    expect(createdId).toBe(PIECE);
    expect(createOptions).toEqual({ repository, start: false });

    const pieceConfig = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "notes",
    };
    const deps = {
      loadManager: () => Promise.resolve(manager as any),
      resolvePieceAddress: () => Promise.resolve(PIECE),
      createController: () => ({
        get: () =>
          Promise.resolve({
            setPattern: (_program: unknown, options: unknown) => {
              setPatternOptions = options;
              return Promise.resolve();
            },
          }),
      } as any),
      getPinnedProgramFromFile: () => Promise.resolve(program),
    };

    await setPiecePattern(pieceConfig, entry, {}, deps);
    expect(setPatternOptions).toEqual({ repository });

    await setPiecePattern(
      pieceConfig,
      entry,
      { dangerouslyAllowIncompatibleSchema: true },
      deps,
    );
    expect(setPatternOptions).toEqual({
      repository,
      dangerouslyAllowIncompatibleSchema: true,
    });
  });

  it("returns pattern provenance from piece inspection", async () => {
    const patternRef = {
      identity: "B".repeat(43),
      symbol: "default",
      source: { ref: `cf:pattern:${"B".repeat(43)}` },
    };
    const inspected = await inspectPiece(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: "notes" },
      {
        loadManager: () => Promise.resolve({} as any),
        resolvePieceAddress: () => Promise.resolve(PIECE),
        createController: () => ({
          get: () =>
            Promise.resolve({
              id: PIECE,
              name: () => "Notes",
              getPatternRef: () => Promise.resolve(patternRef),
              input: { get: () => Promise.resolve({ title: "Input" }) },
              result: { get: () => Promise.resolve({ title: "Result" }) },
              readingFrom: () => Promise.resolve([]),
              readBy: () => Promise.resolve([]),
            }),
        } as any),
      },
    );

    expect(inspected.patternRef).toEqual(patternRef);
    expect(inspected.id).toBe(PIECE);
  });

  it("forwards repository metadata when deploying a home pattern", async () => {
    const repository = "https://github.com/commontoolsinc/labs";
    let recreateOptions: unknown;

    await setHomePattern(
      { apiUrl: API_URL, identity: ID },
      { mainPath: "/repo/home.tsx", repository },
      {
        loadIdentity: () =>
          Promise.resolve({ did: () => "did:key:home" } as any),
        loadManager: () => Promise.resolve({} as any),
        getProgramFromFile: () => Promise.resolve({} as any),
        createController: () => ({
          recreateDefaultPattern: (options: unknown) => {
            recreateOptions = options;
            return Promise.resolve({ id: PIECE });
          },
        } as any),
      },
    );

    expect(recreateOptions).toEqual({
      customProgram: {},
      repository,
    });
  });

  it("shows set-slug command options", async () => {
    const { code, stdout, stderr } = await cf("piece set-slug --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(code).toBe(0);
    expect(output).toContain("Set a slug redirect");
    expect(output).toContain("--resolve-before-linking");
  });

  it("resolves slug piece config through storage", async () => {
    const manager = {};
    const resolved = await resolvePieceConfig({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "demo",
    }, {
      loadManager: (config: SpaceConfig) => {
        expect(config.space).toBe(SPACE);
        return Promise.resolve(manager as any);
      },
      resolvePieceAddress: (seenManager: unknown, token: string) => {
        expect(seenManager).toBe(manager);
        expect(token).toBe("demo");
        return Promise.resolve(PIECE);
      },
    });

    expect(resolved.piece).toBe(PIECE);
  });

  it("preserves URI piece config without slug lookup", async () => {
    const resolved = await resolvePieceConfig({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "of:fid1:piece-123",
    }, {
      loadManager: () => Promise.resolve({} as any),
    });

    expect(resolved.piece).toBe("of:fid1:piece-123");
  });

  it("preserves URI link endpoints without slug lookup", async () => {
    const token = "of:fid1:piece-123";
    const resolved = await resolveLinkEndpointAddress({} as any, token);

    expect(resolved).toBe(token);
  });

  it("rejects a bare endpoint with no slug document, even with the fallback", async () => {
    const manager = {};
    // A colon-less token (a bare name, or a legacy CID) is not an id-shaped
    // endpoint, so the missing-slug fallback does not preserve it; with no slug
    // document it is genuinely missing rather than a usable raw id.
    const token = "a-bare-name";
    await expect(resolveLinkEndpointAddress(
      manager as any,
      token,
      () =>
        Promise.reject(
          new SlugResolutionError(`Slug "${token}" not found.`, "missing"),
        ),
      { allowMissingSlugFallback: true },
    )).rejects.toThrow(/Slug "a-bare-name" not found/);
  });

  it("rejects missing destination slug endpoints", async () => {
    const manager = {};
    const token = "demo";
    await expect(resolveLinkEndpointAddress(
      manager as any,
      token,
      () =>
        Promise.reject(
          new SlugResolutionError(`Slug "${token}" not found.`, "missing"),
        ),
    )).rejects.toThrow(/Slug "demo" not found/);
  });
});
