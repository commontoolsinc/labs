import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import {
  newPiece,
  type NewPieceDependencies,
  recreateSpaceRootPattern,
  resolveLinkEndpointAddress,
  resolvePieceConfig,
  type SpaceConfig,
  withRuntimeCleanupOnFailure,
} from "../lib/piece.ts";
import {
  PieceManager,
  resolvePieceAddress,
  SlugResolutionError,
} from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  normalizeApiUrl,
  parseLink,
  parsePieceOptions,
  parseSpaceOptions,
} from "../commands/piece.ts";

const API_URL = "https://cf.dev";
const SPACE = "common-knowledge";
const PIECE = "abcdefghijklmnopqrstuvwxyz";
const ID = "~/.my.key";
const FULL_URL = `${API_URL}/${SPACE}/${PIECE}`;
const NO_PIECE_FULL_URL = `${API_URL}/${SPACE}`;

describe("cli piece parsing", () => {
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

  it("shows slug option for piece new", async () => {
    const { code, stdout, stderr } = await cf("piece new --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(code).toBe(0);
    expect(output).toContain("--slug");
    expect(output).not.toContain("--no-register");
  });

  it("preflights registration before resolving or creating a piece", async () => {
    const homeSpace = "did:key:z6Mktest-home";
    const calls: string[] = [];
    const manager = {
      getSpace: () => homeSpace,
      runtime: { userIdentityDID: homeSpace },
      assertCanAddPieces: () => {
        calls.push("preflight");
        return Promise.reject(
          new Error("addPiece handler not found on default pattern"),
        );
      },
      add: () => {
        calls.push("add");
        return Promise.resolve();
      },
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => {
        calls.push("ensure-root");
        return Promise.resolve({});
      },
      create: () => {
        calls.push("create");
        return Promise.reject(new Error("create must not run"));
      },
    } as unknown as PiecesController;
    const deps: NewPieceDependencies = {
      loadManager: () => {
        calls.push("load-manager");
        return Promise.resolve(manager);
      },
      createController: () => controller,
      getProgram: () => {
        calls.push("resolve-program");
        return Promise.reject(new Error("program resolution must not run"));
      },
    };

    let message = "";
    try {
      await newPiece(
        { apiUrl: API_URL, space: homeSpace, identity: ID },
        { mainPath: "/tmp/pattern.tsx" },
        {},
        deps,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(calls).toEqual(["load-manager", "ensure-root", "preflight"]);
    expect(message).toContain("No new piece was created");
    expect(message).toContain("home space is not a piece registry");
    expect(message).toContain("piece new --space <space-name> <main>");
    expect(message).not.toContain("recreate-root");
  });

  it("validates a slug before loading a manager", async () => {
    let managerLoaded = false;
    const deps: NewPieceDependencies = {
      loadManager: () => {
        managerLoaded = true;
        return Promise.reject(new Error("manager must not load"));
      },
    };

    await expect(newPiece(
      { apiUrl: API_URL, space: "named-space", identity: ID },
      { mainPath: "/tmp/pattern.tsx" },
      { slug: "Invalid Slug" },
      deps,
    )).rejects.toThrow(/lowercase letters, numbers/);
    expect(managerLoaded).toBe(false);
  });

  it("registers a new piece before assigning its optional slug", async () => {
    const calls: string[] = [];
    const pieceCell = {};
    const manager = {
      getSpace: () => "did:key:z6Mktest-space",
      runtime: { userIdentityDID: "did:key:z6Mktest-home" },
      assertCanAddPieces: () => {
        calls.push("preflight");
        return Promise.resolve();
      },
      add: () => {
        calls.push("register");
        return Promise.resolve();
      },
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => {
        calls.push("ensure-root");
        return Promise.resolve({});
      },
      create: () => {
        calls.push("create");
        return Promise.resolve({
          id: "fid1:created-piece",
          getCell: () => pieceCell,
        });
      },
    } as unknown as PiecesController;

    const id = await newPiece(
      { apiUrl: API_URL, space: "named-space", identity: "/tmp/test.key" },
      { mainPath: "/tmp/pattern.tsx" },
      { slug: "demo" },
      {
        loadManager: () => {
          calls.push("load-manager");
          return Promise.resolve(manager);
        },
        createController: () => controller,
        getProgram: () => {
          calls.push("resolve-program");
          return Promise.resolve({} as RuntimeProgram);
        },
        assignSlug: (_manager, cell, slug) => {
          expect(cell).toBe(pieceCell);
          expect(slug).toBe("demo");
          calls.push("assign-slug");
          return Promise.resolve();
        },
      },
    );

    expect(id).toBe("fid1:created-piece");
    expect(calls).toEqual([
      "load-manager",
      "ensure-root",
      "preflight",
      "resolve-program",
      "create",
      "register",
      "assign-slug",
    ]);
  });

  it("reports an unknown outcome when registration settling fails", async () => {
    const calls: string[] = [];
    const manager = {
      getSpace: () => "did:key:z6Mktest-space",
      runtime: { userIdentityDID: "did:key:z6Mktest-home" },
      assertCanAddPieces: () => Promise.resolve(),
      add: () => {
        calls.push("register");
        return Promise.reject(new Error("transaction exhausted"));
      },
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => Promise.resolve({}),
      create: () =>
        Promise.resolve({
          id: "fid1:created-but-unregistered",
          getCell: () => ({}),
        }),
    } as unknown as PiecesController;

    let message = "";
    try {
      await newPiece(
        { apiUrl: API_URL, space: "named-space", identity: "/tmp/test.key" },
        { mainPath: "/tmp/pattern.tsx" },
        { slug: "demo" },
        {
          loadManager: () => Promise.resolve(manager),
          createController: () => controller,
          getProgram: () => Promise.resolve({} as RuntimeProgram),
          assignSlug: () => {
            calls.push("assign-slug");
            return Promise.resolve();
          },
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(calls).toEqual(["register"]);
    expect(message).toContain("fid1:created-but-unregistered");
    expect(message).toContain("transaction exhausted");
    expect(message).toContain("registration outcome is unknown");
    expect(message).toContain("may have committed before settling failed");
    expect(message).toContain(
      `${API_URL}/named-space/fid1:created-but-unregistered`,
    );
    expect(message).toContain(
      `cf piece ls --identity /tmp/test.key --api-url ${API_URL} ` +
        "--space named-space",
    );
  });

  it("reports exact slug recovery after the piece is registered", async () => {
    const calls: string[] = [];
    const manager = {
      getSpace: () => "did:key:z6Mktest-space",
      runtime: { userIdentityDID: "did:key:z6Mktest-home" },
      assertCanAddPieces: () => Promise.resolve(),
      add: () => {
        calls.push("register");
        return Promise.resolve();
      },
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => Promise.resolve({}),
      create: () =>
        Promise.resolve({
          id: "fid1:registered-without-slug",
          getCell: () => ({}),
        }),
    } as unknown as PiecesController;

    let message = "";
    try {
      await newPiece(
        { apiUrl: API_URL, space: "named-space", identity: "/tmp/test.key" },
        { mainPath: "/tmp/pattern.tsx" },
        { slug: "demo" },
        {
          loadManager: () => Promise.resolve(manager),
          createController: () => controller,
          getProgram: () => Promise.resolve({} as RuntimeProgram),
          assignSlug: () => {
            calls.push("assign-slug");
            return Promise.reject(new Error("slug storage unavailable"));
          },
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(calls).toEqual(["register", "assign-slug"]);
    expect(message).toContain("fid1:registered-without-slug");
    expect(message).toContain("slug storage unavailable");
    expect(message).toContain("remains registered");
    expect(message).toContain(
      `${API_URL}/named-space/fid1:registered-without-slug`,
    );
    expect(message).toContain(
      "cf piece set-slug --identity /tmp/test.key " +
        `--api-url ${API_URL} --space named-space demo ` +
        "fid1:registered-without-slug",
    );
  });

  it("shell-quotes dynamic values in recovery commands", async () => {
    const identity = "/tmp/key with 'quote.key";
    const apiUrl = "https://cf.dev/root?x=1&y=$(nope)";
    const space = "named space;echo nope";
    const manager = {
      getSpace: () => "did:key:z6Mktest-space",
      runtime: { userIdentityDID: "did:key:z6Mktest-home" },
      assertCanAddPieces: () => Promise.resolve(),
      add: () => Promise.resolve(),
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => Promise.resolve({}),
      create: () =>
        Promise.resolve({
          id: "fid1:shell-safe-recovery",
          getCell: () => ({}),
        }),
    } as unknown as PiecesController;

    let message = "";
    try {
      await newPiece(
        { apiUrl, space, identity },
        { mainPath: "/tmp/pattern.tsx" },
        { slug: "demo" },
        {
          loadManager: () => Promise.resolve(manager),
          createController: () => controller,
          getProgram: () => Promise.resolve({} as RuntimeProgram),
          assignSlug: () => Promise.reject(new Error("slug write failed")),
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "cf piece set-slug --identity '/tmp/key with '\\''quote.key' " +
        "--api-url 'https://cf.dev/root?x=1&y=$(nope)' " +
        "--space 'named space;echo nope' demo fid1:shell-safe-recovery",
    );
  });

  it("registers and cold-loads a slugged piece in a named space", async () => {
    const identity = await Identity.fromPassphrase(
      "cli registered named-space piece cold persistence",
    );
    const storageManager = StorageManager.emulate({ as: identity });
    const firstRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    let freshRuntime: Runtime | undefined;
    const spaceName = `registered-piece-${crypto.randomUUID()}`;
    const slug = "cold-registered-piece";
    const defaultPatternProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "/// <cf-disable-transform />",
          "import { handler, pattern } from 'commonfabric';",
          "const addPiece = handler<{ piece: unknown }, { allPieces: unknown[] }>(",
          "  ({ piece }, { allPieces }) => { allPieces.push(piece); },",
          "  { proxy: true },",
          ");",
          "export default pattern<{ allPieces: unknown[] }>(({ allPieces }) => ({",
          "  allPieces,",
          "  addPiece: addPiece({ allPieces }),",
          "}));",
        ].join("\n"),
      }],
    };
    const pieceProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "/// <cf-disable-transform />",
          "import { pattern } from 'commonfabric';",
          "export default pattern(() => ({ marker: 'persisted' }));",
        ].join("\n"),
      }],
    };

    try {
      const firstSession = await createSession({ identity, spaceName });
      const firstManager = new PieceManager(firstSession, firstRuntime);
      await firstManager.synced();
      expect(firstManager.getSpace()).not.toBe(firstRuntime.userIdentityDID);

      const compiledDefaultPattern = await firstRuntime.patternManager
        .compilePattern(defaultPatternProgram, {
          space: firstManager.getSpace(),
        });
      const defaultPatternPiece = await firstManager.runPersistent(
        compiledDefaultPattern,
        { allPieces: [] },
        "registered-piece-default-pattern",
      );
      await firstManager.linkDefaultPattern(defaultPatternPiece);
      await firstRuntime.idle();
      await firstManager.synced();

      const id = await newPiece(
        {
          apiUrl: "http://toolshed.test",
          space: firstManager.getSpace(),
          identity: "/unused/test.key",
        },
        { mainPath: "/unused/main.tsx" },
        { slug },
        {
          loadManager: () => Promise.resolve(firstManager),
          getProgram: () => Promise.resolve(pieceProgram),
        },
      );

      const firstPieces = new PiecesController(firstManager);
      expect((await firstPieces.getAllPieces()).map((piece) => piece.id))
        .toContain(id);
      expect(await resolvePieceAddress(firstManager, slug)).toBe(id);
      await firstManager.synced();
      await firstManager.stopPiece(id);

      const freshSession = await createSession({ identity, spaceName });
      freshRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      const freshManager = new PieceManager(freshSession, freshRuntime);
      await freshManager.synced();

      const freshPieces = new PiecesController(freshManager);
      expect((await freshPieces.getAllPieces()).map((piece) => piece.id))
        .toContain(id);
      const resolvedId = await resolvePieceAddress(freshManager, slug);
      expect(resolvedId).toBe(id);
      const freshPiece = await freshPieces.get(resolvedId, true);
      expect(await freshPiece.result.get()).toEqual({ marker: "persisted" });
    } finally {
      await freshRuntime?.dispose();
      await firstRuntime.dispose();
      await storageManager.close();
    }
  });

  it("retains root repair guidance for non-home initialization failure", async () => {
    const manager = {
      getSpace: () => "did:key:z6Mktest-other",
      runtime: { userIdentityDID: "did:key:z6Mktest-home" },
    } as unknown as PieceManager;
    const controller = {
      ensureDefaultPattern: () => Promise.reject(new Error("broken root")),
    } as unknown as PiecesController;
    const deps: NewPieceDependencies = {
      loadManager: () => Promise.resolve(manager),
      createController: () => controller,
    };

    let message = "";
    try {
      await newPiece(
        {
          apiUrl: API_URL,
          space: "did:key:z6Mktest-other",
          identity: ID,
        },
        { mainPath: "/tmp/pattern.tsx" },
        {},
        deps,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Could not initialize the space's root pattern");
    expect(message).toContain("piece recreate-root");
    expect(message).not.toContain("--no-register");
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
