import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import {
  inspectPiece,
  listPieces,
  newPiece,
  recreateSpaceRootPattern,
  resolveLinkEndpointAddress,
  resolvePieceConfig,
  setHomePattern,
  setPiecePattern,
  type SpaceConfig,
  withRuntimeCleanupOnFailure,
} from "../lib/piece.ts";
import { SlugResolutionError } from "@commonfabric/piece";
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
