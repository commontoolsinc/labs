import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { taggedHashStringOf } from "@commonfabric/data-model/value-hash";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  browserWorkerParamsFromInitializationData,
  postVersionSkew,
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  RuntimeProcessor,
  sanitizeForPostMessage,
  shouldReconcileHomeRoot,
  versionSkewNotification,
} from "./runtime-processor.ts";
import { atomsOutsideCeiling } from "@commonfabric/runner/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";
import { type RuntimeFetch, runtimePresets } from "@commonfabric/runner";
import {
  type CellRef,
  type CfcLabelView,
  ClientNotificationType,
  NotificationType,
  RequestType,
} from "../protocol/mod.ts";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  cellRefToSigilLink,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";
import { Runtime } from "@commonfabric/runner";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import * as V2Storage from "../../runner/src/storage/v2.ts";
import { parseLink } from "../../runner/src/link-utils.ts";

const cfcSigner = await Identity.fromPassphrase(
  "runtime-processor-cfc-label-tests",
);
const testSessionOpenAudience = "did:key:z6Mk-runtime-processor-test-audience";

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {
          principal: cfcSigner.did(),
        },
      }),
    );
    return { client, session };
  }
}

class SharedV2StorageManager extends V2Storage.StorageManager {
  constructor(options: V2Storage.Options, server: MemoryV2Server.Server) {
    super(options, new SharedV2SessionFactory(server));
  }
}

const createRuntime = () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: testSessionOpenAudience,
    },
  });
  const storageManager = new SharedV2StorageManager({
    as: cfcSigner,
    memoryHost: new URL("memory://"),
  }, server);
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost/"),
    storageManager,
  });
  return { runtime, storageManager };
};

// Handlers resolve their per-space piece context via getSpaceCtx
// (federation PR2). The duck-typed processors below are single-space:
// their context is always the home pieceManager/cc.
function homeSpaceCtx(this: { pieceManager?: unknown; cc?: unknown }) {
  return { pieceManager: this.pieceManager, cc: this.cc };
}

// A valid `fid1:` page id from a readable seed (handlers parse pageId via
// `entityIdFrom`, which requires a real tagged-hash string).
const fid = (seed: string) => taggedHashStringOf(seed);

describe("renderConfidentialityResolverFor (H3b)", () => {
  it("returns undefined when no ceiling is configured", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      expect(
        renderConfidentialityResolverFor(runtime, cfcSigner, undefined),
      ).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves the acting user's own space against a ceiling", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const resolver = renderConfidentialityResolverFor(runtime, cfcSigner, {
        atoms: [cfcAtom.user(cfcSigner.did())],
      });
      expect(resolver).toBeDefined();
      const ceiling = [cfcAtom.user(cfcSigner.did())];
      // The acting user's own space (space DID == principal DID) is a verified
      // member, so a Space label naming it resolves to User(actingUser).
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space(cfcSigner.did())] }),
          ceiling,
        ),
      ).toEqual([]);
      // A different space the acting user has no verified role in stays blocked.
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space("did:key:z6MkElse")] }),
          ceiling,
        ),
      ).toEqual([cfcAtom.space("did:key:z6MkElse")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves the session workspace when it differs from the principal DID", async () => {
    // createSession({ spaceName }) derives a home-space DID distinct from the
    // acting principal; the session-authorized workspace is a verified member,
    // so its own Space(...) label resolves rather than over-blocking.
    const { runtime, storageManager } = createRuntime();
    const sessionSpace = "did:key:z6MkSessionWorkspaceDistinct";
    try {
      const resolver = renderConfidentialityResolverFor(
        runtime,
        cfcSigner,
        { atoms: [cfcAtom.user(cfcSigner.did())] },
        sessionSpace,
      );
      const ceiling = [cfcAtom.user(cfcSigner.did())];
      // The session workspace resolves...
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space(sessionSpace)] }),
          ceiling,
        ),
      ).toEqual([]);
      // ...and the acting user's own identity space still resolves too.
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space(cfcSigner.did())] }),
          ceiling,
        ),
      ).toEqual([]);
      // A third, unrelated space stays blocked.
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space("did:key:z6MkThird")] }),
          ceiling,
        ),
      ).toEqual([cfcAtom.space("did:key:z6MkThird")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves a cross-space Space label the space's ACL grants (§4.9.3)", async () => {
    // §4.9.3 membership lookup: the helper wires a runtime-backed provider that
    // reads each space's ACL doc. A space whose declared ACL grants the acting
    // user READ resolves; one that does not (no ACL / residency only) blocks.
    const { runtime, storageManager } = createRuntime();
    const grantedSpace = "did:key:z6MkGrantedSpaceForRenderTest";
    const deniedSpace = "did:key:z6MkDeniedSpaceForRenderTest";
    try {
      // Seed the granted space's ACL doc (entity id == space DID) with a READ
      // grant for the acting user. The denied space gets no ACL doc at all —
      // its bytes may still be resident, but residency is not read authority.
      const aclCell = runtime.getCellFromLink({
        id: `of:${grantedSpace}`,
        path: [],
        space: grantedSpace as MemorySpace,
      });
      const tx = runtime.edit();
      aclCell.withTx(tx).set({
        [grantedSpace]: "OWNER",
        [cfcSigner.did()]: "READ",
      });
      await tx.commit();
      await runtime.idle();
      await storageManager.synced();

      const resolver = renderConfidentialityResolverFor(runtime, cfcSigner, {
        atoms: [cfcAtom.user(cfcSigner.did())],
      });
      const ceiling = [cfcAtom.user(cfcSigner.did())];
      // The ACL-granted space resolves to User(actingUser).
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space(grantedSpace)] }),
          ceiling,
        ),
      ).toEqual([]);
      // The space with no granting ACL stays blocked (fail-closed).
      expect(
        atomsOutsideCeiling(
          resolver!({ confidentiality: [cfcAtom.space(deniedSpace)] }),
          ceiling,
        ),
      ).toEqual([cfcAtom.space(deniedSpace)]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("renderMembershipProviderFor (§4.9.3 Stage 2)", () => {
  it("returns undefined when no ceiling is configured", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      expect(renderMembershipProviderFor(runtime, cfcSigner, undefined))
        .toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("builds a runtime-backed provider that reads a space's ACL doc", async () => {
    const { runtime, storageManager } = createRuntime();
    const grantedSpace = "did:key:z6MkGrantedSpaceForProviderTest";
    try {
      const aclCell = runtime.getCellFromLink({
        id: `of:${grantedSpace}`,
        path: [],
        space: grantedSpace as MemorySpace,
      });
      const tx = runtime.edit();
      aclCell.withTx(tx).set({
        [grantedSpace]: "OWNER",
        [cfcSigner.did()]: "READ",
      });
      await tx.commit();
      await runtime.idle();
      await storageManager.synced();

      const provider = renderMembershipProviderFor(runtime, cfcSigner, {
        atoms: [cfcAtom.user(cfcSigner.did())],
      });
      expect(provider).toBeDefined();
      // The acting user's own space is an implicit OWNER (no ACL read).
      expect(provider!.readerRole(cfcSigner.did())).toBe("owner");
      // A space whose ACL grants READ resolves to a reader role.
      expect(provider!.readerRole(grantedSpace)).toBe("reader");
      // A space with no ACL doc fails closed.
      expect(provider!.readerRole("did:key:z6MkNoAclProviderTest")).toBeNull();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("page slug metadata", () => {
  it("reads slug metadata from the page document root", async () => {
    const reads: unknown[] = [];
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: () => ({
          sync: () => Promise.resolve(),
          getMetaRaw: (metaField: string) => {
            reads.push({
              space: "did:key:z6Mk-runtime-processor-slug",
              id: "of:fid1-slugged-piece",
              scope: "space",
              path: [metaField],
            });
            return metaField === "slug" ? "demo" : undefined;
          },
        }),
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGetSlug
      .call(processor, {
        type: RequestType.PageGetSlug,
        pageId: fid("slugged-piece"),
      });

    expect(result).toEqual({ slug: "demo" });
    expect(reads).toEqual([{
      space: "did:key:z6Mk-runtime-processor-slug",
      id: "of:fid1-slugged-piece",
      scope: "space",
      path: ["slug"],
    }]);
  });

  it("ignores non-string slug metadata", async () => {
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: () => ({
          sync: () => Promise.resolve(),
          getMetaRaw: (metaField: string) =>
            metaField === "slug" ? { not: "a slug" } : undefined,
        }),
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGetSlug
      .call(processor, {
        type: RequestType.PageGetSlug,
        pageId: fid("slugged-piece"),
      });

    expect(result).toEqual({ slug: undefined });
  });

  it("accepts bare and of:-schemed pageIds as the same entity", async () => {
    // CellHandle.id() emits the full schemed URI while PageHandle.id() emits
    // the bare routing form; the pageId intake must resolve both to the SAME
    // entity. Without normalization, "of:fid1:H" parses as a hash whose tag
    // is "of:fid1" and silently addresses the nonexistent of:of:fid1:H.
    const received: string[] = [];
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: (_space: unknown, entityId: unknown) => {
          received.push(String(entityId));
          return {
            sync: () => Promise.resolve(),
            getMetaRaw: () => undefined,
          };
        },
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    const bare = fid("schemed-piece");
    for (const pageId of [bare, `of:${bare}`]) {
      await (RuntimeProcessor.prototype as any).handlePageGetSlug
        .call(processor, { type: RequestType.PageGetSlug, pageId });
    }

    expect(received).toEqual([bare, bare]);
  });

  it("rejects computed ids as page ids", async () => {
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: () => {
          throw new Error("computed page id reached the runtime lookup");
        },
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    await expect(
      (RuntimeProcessor.prototype as any).handlePageGetSlug.call(processor, {
        type: RequestType.PageGetSlug,
        pageId: `computed:${fid("not-a-page")}`,
      }),
    ).rejects.toThrow("Computed ids are not valid page ids");
  });
});

describe("page slug redirects", () => {
  const space = "did:key:z6Mk-runtime-processor-page-redirect" as CellRef[
    "space"
  ];

  function mockCell(ref: CellRef, options: {
    raw?: unknown;
    schemaCell?: unknown;
    onPull?: () => void;
    patternLink?: unknown;
    patternIdentity?: unknown;
    onSync?: () => void;
  } = {}) {
    return {
      sync: () => {
        options.onSync?.();
        return Promise.resolve();
      },
      pull: () => {
        options.onPull?.();
        return Promise.resolve(options.raw);
      },
      getRaw: () => options.raw,
      getMetaRaw: (metaField: string) =>
        metaField === "patternIdentity"
          ? options.patternIdentity
          : metaField === "pattern"
          ? options.patternLink
          : undefined,
      getAsLink: () => cellRefToSigilLink(ref),
      getAsNormalizedFullLink: () => ref,
      asSchemaFromLinks: () => options.schemaCell,
    };
  }

  function redirectRaw(ref: CellRef) {
    return {
      "/": {
        "link@1": {
          ...ref,
          overwrite: "redirect",
        },
      },
    };
  }

  it("normalizes an of:-schemed id before the piece-manager lookup", async () => {
    const bare = fid("ordinary-page");
    const requestedRef: CellRef = {
      id: `of:${bare}` as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const resultRef: CellRef = {
      id: `of:${fid("ordinary-page-result")}` as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const requestedCell = mockCell(requestedRef);
    const resultCell = mockCell(resultRef);
    const managerCalls: unknown[][] = [];
    const processor = {
      getSpaceCtx: () => ({
        pieceManager: { getSpace: () => space },
        cc: {
          manager: () => ({
            get: (...args: unknown[]) => {
              managerCalls.push(args);
              return Promise.resolve(resultCell);
            },
          }),
        },
      }),
      runtime: {
        getCellFromEntityId: () => requestedCell,
      },
    };

    await (RuntimeProcessor.prototype as any).handlePageGet.call(processor, {
      type: RequestType.PageGet,
      pageId: `of:${bare}`,
      runIt: true,
      space,
    });

    expect(managerCalls).toEqual([[bare, true]]);
  });

  it("renders slug redirects to output cells directly", async () => {
    const targetRef: CellRef = {
      id: "of:fid1-sub-page" as CellRef["id"],
      space,
      scope: "space",
      path: ["capture"],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    let targetSynced = false;
    const targetCell = mockCell(targetRef, {
      onSync: () => {
        targetSynced = true;
      },
    });
    const slugCell = mockCell(slugRef, { raw: redirectRaw(targetRef) });
    const manager = {
      get: () => {
        throw new Error("output-cell slug redirects should not load as pieces");
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => targetCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: fid("slug-doc"),
        runIt: true,
      });

    expect(targetSynced).toBe(true);
    expect(result.page.cell).toMatchObject(targetRef);
  });

  it("renders slug redirects to nested output cells directly", async () => {
    const targetRef: CellRef = {
      id: "of:fid1-parent-page" as CellRef["id"],
      space,
      scope: "space",
      path: ["activityTab"],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const schemaRef: CellRef = {
      ...targetRef,
      schema: {
        type: "object",
        properties: {
          "$NAME": { type: "string" },
          "$UI": { type: "object" },
        },
        required: ["$NAME", "$UI"],
      },
    };
    // If we don't have a pattern identity, the processor won't pull the cell and
    // thus won't pull the schema, so include the current piece marker.
    const patternIdentity = { identity: "pattern-identity", symbol: "default" };
    let schemaPulled = false;
    const schemaCell = mockCell(schemaRef, {
      onPull: () => {
        schemaPulled = true;
      },
    });
    let targetSynced = false;
    const targetCell = mockCell(targetRef, {
      schemaCell,
      patternIdentity,
      onSync: () => {
        targetSynced = true;
      },
    });
    const slugCell = mockCell(slugRef, { raw: redirectRaw(targetRef) });
    const manager = {
      get: () => {
        throw new Error(
          "nested output-cell slug redirects should not load as pieces",
        );
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => targetCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: fid("slug-doc"),
        runIt: true,
      });

    expect(targetSynced).toBe(true);
    expect(schemaPulled).toBe(true);
    expect(result.page.cell).toMatchObject(schemaRef);
  });

  it("loads slug redirects to piece cells through the piece manager", async () => {
    const pieceRef: CellRef = {
      id: "of:fid1-piece" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const resultRef: CellRef = {
      id: "of:fid1-piece-result" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const pieceCell = mockCell(pieceRef, {
      patternIdentity: {
        identity: "piece-pattern-identity",
        symbol: "default",
      },
    });
    const resultCell = mockCell(resultRef);
    const slugCell = mockCell(slugRef, { raw: redirectRaw(pieceRef) });
    const calls: unknown[][] = [];
    const manager = {
      get: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(resultCell);
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => pieceCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: fid("slug-doc"),
        runIt: true,
      });

    expect(calls).toEqual([[pieceCell, true]]);
    expect(result.page.cell).toMatchObject(resultRef);
  });
});

describe("sanitizeForPostMessage", () => {
  describe("primitives", () => {
    it("passes through null and undefined", () => {
      expect(sanitizeForPostMessage(null)).toBe(null);
      expect(sanitizeForPostMessage(undefined)).toBe(undefined);
    });

    it("passes through numbers, strings, and booleans", () => {
      expect(sanitizeForPostMessage(42)).toBe(42);
      expect(sanitizeForPostMessage("hello")).toBe("hello");
      expect(sanitizeForPostMessage(true)).toBe(true);
    });
  });

  describe("functions", () => {
    it("converts functions to placeholder strings", () => {
      expect(sanitizeForPostMessage(() => {})).toBe("[Function]");
      expect(sanitizeForPostMessage(function named() {})).toBe("[Function]");
    });
  });

  describe("plain objects", () => {
    it("passes through simple objects", () => {
      const obj = { name: "test", count: 42 };
      expect(sanitizeForPostMessage(obj)).toEqual({ name: "test", count: 42 });
    });

    it("handles nested objects", () => {
      const obj = { outer: { inner: { value: 1 } } };
      expect(sanitizeForPostMessage(obj)).toEqual({
        outer: { inner: { value: 1 } },
      });
    });

    it("converts function properties to placeholders", () => {
      const obj = { name: "test", callback: () => {} };
      expect(sanitizeForPostMessage(obj)).toEqual({
        name: "test",
        callback: "[Function]",
      });
    });
  });

  describe("arrays", () => {
    it("handles arrays of primitives", () => {
      expect(sanitizeForPostMessage([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("handles arrays of objects", () => {
      const arr = [{ a: 1 }, { b: 2 }];
      expect(sanitizeForPostMessage(arr)).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("converts function elements to placeholders", () => {
      const arr = [1, () => {}, 3];
      expect(sanitizeForPostMessage(arr)).toEqual([1, "[Function]", 3]);
    });
  });

  describe("circular references", () => {
    it("detects and handles circular references", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      expect(sanitizeForPostMessage(obj)).toEqual({
        name: "test",
        self: "[Circular]",
      });
    });

    it("handles circular arrays", () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(sanitizeForPostMessage(arr)).toEqual([1, 2, "[Circular]"]);
    });
  });

  describe("depth limit", () => {
    it("stops at max depth", () => {
      const deepObj = {
        l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } },
      };
      const result = sanitizeForPostMessage(deepObj) as Record<string, unknown>;
      // At depth 5, l6 should be "[Max depth exceeded]"
      expect(
        (
          (
            ((result.l1 as Record<string, unknown>).l2 as Record<
              string,
              unknown
            >)
              .l3 as Record<string, unknown>
          ).l4 as Record<string, unknown>
        ).l5,
      ).toBe("[Max depth exceeded]");
    });
  });

  describe("objects with throwing property access", () => {
    it("handles objects with properties that throw on read", () => {
      // Create an object where reading a specific property throws
      const obj = {
        safe: "value",
        get dangerous(): never {
          throw new Error("Cannot read this property");
        },
      };

      const result = sanitizeForPostMessage(obj) as Record<string, unknown>;
      expect(result.safe).toBe("value");
      expect(result.dangerous).toBe("[Unreadable]");
    });

    it("handles proxies with throwing get trap", () => {
      const throwingProxy = new Proxy(
        {},
        {
          get() {
            throw new Error("Cannot access property");
          },
          ownKeys() {
            return ["problematic"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true };
          },
        },
      );

      // isCellResult() probes symbol-backed access first, so a hostile get trap
      // is treated as an uncloneable object before the plain-object walker runs.
      const result = sanitizeForPostMessage(throwingProxy);
      expect(result).toBe("[Object - uncloneable]");
    });

    it("handles proxies that throw on Object.keys", () => {
      const throwingProxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("Cannot list keys");
          },
        },
      );

      // When we can't iterate, we fall back to placeholder
      const result = sanitizeForPostMessage(throwingProxy);
      expect(result).toBe("[Object - uncloneable]");
    });
  });

  describe("mixed structures", () => {
    it("handles complex nested structures with various types", () => {
      const complex = {
        name: "root",
        items: [
          { id: 1, process: () => {} },
          { id: 2, nested: { deep: true } },
        ],
        metadata: {
          count: 42,
          handler: function handle() {},
        },
      };

      expect(sanitizeForPostMessage(complex)).toEqual({
        name: "root",
        items: [
          { id: 1, process: "[Function]" },
          { id: 2, nested: { deep: true } },
        ],
        metadata: {
          count: 42,
          handler: "[Function]",
        },
      });
    });
  });
});

describe("RuntimeProcessor diagnosis helpers", () => {
  it("passes detectNonIdempotent duration through to scheduler.runDiagnosis", async () => {
    const expected = {
      nonIdempotent: [],
      cycles: [],
      duration: 321,
      busyTime: 123,
    };
    let receivedDuration: number | undefined;
    const processor = {
      runtime: {
        scheduler: {
          runDiagnosis: (durationMs?: number) => {
            receivedDuration = durationMs;
            return expected;
          },
        },
      },
    } as unknown as RuntimeProcessor;

    const response = await RuntimeProcessor.prototype.detectNonIdempotent.call(
      processor,
      {
        type: RequestType.DetectNonIdempotent,
        durationMs: 2500,
      },
    );

    expect(receivedDuration).toBe(2500);
    expect(response).toEqual({ result: expected });
  });

  it("routes settle and trigger trace helpers to the scheduler", () => {
    const expected = {
      iterations: [{
        workSetSize: 3,
        orderSize: 2,
        actionsRun: 2,
        actions: [{ id: "action:test", type: "computation" as const }],
        durationMs: 12.5,
      }],
      totalDurationMs: 12.5,
      settledEarly: true,
      initialSeedCount: 1,
    };
    const history = [{
      recordedAt: 1234.5,
      stats: expected,
    }];
    const actionTrace = [{
      recordedAt: 2234.5,
      actionId: "action:compute",
      actionType: "computation" as const,
      parentActionId: "action:parent",
      durationMs: 3.5,
      declaredWrites: [{
        space: "did:key:test",
        entityId: "cell-2",
        path: [],
      }],
      actualWrites: [{
        space: "did:key:test",
        entityId: "cell-2",
        path: [],
      }],
    }];
    const triggerTrace = [{
      recordedAt: 2345.6,
      notificationType: "commit",
      changeIndex: 1,
      matchedActionCount: 1,
      mode: "pull" as const,
      writerActionId: "action:writer",
      space: "did:key:test",
      entityId: "cell-1",
      path: ["items", "0"],
      before: { kind: "undefined" as const },
      after: { kind: "object" as const, size: 2 },
      triggered: [{
        actionId: "action:reader",
        actionType: "computation" as const,
        mode: "pull" as const,
        decision: "mark-invalid" as const,
        pendingBefore: false,
        pendingAfter: false,
        dirtyBefore: false,
        dirtyAfter: true,
      }],
    }];
    const settleEnabledValues: boolean[] = [];
    const actionRunEnabledValues: boolean[] = [];
    const triggerEnabledValues: boolean[] = [];
    const writeTraceMatchers: unknown[] = [];
    const writeTrace = [{
      recordedAt: 2456.7,
      space: "did:key:test",
      entityId: "of:cell-1",
      path: [],
      match: "exact" as const,
      label: "watched root write",
      result: "ok" as const,
      valueKind: "object" as const,
      stack: "Error\n  at writeValueOrThrow",
    }];
    const processor = {
      runtime: {
        scheduler: {
          setSettleStatsEnabled: (enabled: boolean) => {
            settleEnabledValues.push(enabled);
          },
          getSettleStats: () => expected,
          getSettleStatsHistory: () => history,
          setActionRunTraceEnabled: (enabled: boolean) => {
            actionRunEnabledValues.push(enabled);
          },
          getActionRunTrace: () => actionTrace,
          setTriggerTraceEnabled: (enabled: boolean) => {
            triggerEnabledValues.push(enabled);
          },
          getTriggerTrace: () => triggerTrace,
        },
        getWriteStackTrace: () => writeTrace,
        setWriteStackTraceMatchers: (matchers: unknown[]) => {
          writeTraceMatchers.push(matchers);
        },
      },
    } as unknown as RuntimeProcessor;

    RuntimeProcessor.prototype.setSettleStatsEnabled.call(processor, {
      type: RequestType.SetSettleStatsEnabled,
      enabled: true,
    });
    RuntimeProcessor.prototype.setActionRunTraceEnabled.call(processor, {
      type: RequestType.SetActionRunTraceEnabled,
      enabled: true,
    });
    RuntimeProcessor.prototype.setTriggerTraceEnabled.call(processor, {
      type: RequestType.SetTriggerTraceEnabled,
      enabled: true,
    });

    const response = RuntimeProcessor.prototype.getSettleStats.call(processor, {
      type: RequestType.GetSettleStats,
    });
    const historyResponse = RuntimeProcessor.prototype.getSettleStatsHistory
      .call(processor, {
        type: RequestType.GetSettleStatsHistory,
      });
    const actionTraceResponse = RuntimeProcessor.prototype.getActionRunTrace
      .call(processor, {
        type: RequestType.GetActionRunTrace,
      });
    const triggerTraceResponse = RuntimeProcessor.prototype.getTriggerTrace
      .call(
        processor,
        {
          type: RequestType.GetTriggerTrace,
        },
      );
    const writeTraceResponse = RuntimeProcessor.prototype.getWriteStackTrace
      .call(
        processor,
        {
          type: RequestType.GetWriteStackTrace,
        },
      );

    expect(settleEnabledValues).toEqual([true]);
    expect(actionRunEnabledValues).toEqual([true]);
    expect(triggerEnabledValues).toEqual([true]);
    expect(response).toEqual({ stats: expected });
    expect(historyResponse).toEqual({ history });
    expect(actionTraceResponse).toEqual({ trace: actionTrace });
    expect(triggerTraceResponse).toEqual({ trace: triggerTrace });
    expect(writeTraceResponse).toEqual({
      trace: writeTrace,
    });

    RuntimeProcessor.prototype.setWriteStackTraceMatchers.call(
      processor,
      {
        type: RequestType.SetWriteStackTraceMatchers,
        matchers: [],
      },
    );
    expect(writeTraceMatchers).toEqual([[]]);
  });
});

describe("RuntimeProcessor blob upload IPC", () => {
  it("posts FabricBytes contents to the blob route and returns an absolute URL", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | undefined;
    let requestedPayload: unknown;
    const blobFetch: RuntimeFetch = (input, init) => {
      requestedUrl = input.toString();
      requestedPayload = decodeMemoryBoundary(init?.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "fid1:test",
            url: "blobs/test.png",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
    globalThis.fetch = blobFetch as typeof globalThis.fetch;
    // The constructor performs full runtime initialization; this focused unit
    // test calls the handler with the fields it reads directly.
    const hostForSpaceCalls: string[] = [];
    const processor = {
      runtime: {
        hostForSpace: (space: string) => {
          hostForSpaceCalls.push(space);
          return new URL("http://toolshed.test/base");
        },
      },
    } as unknown as RuntimeProcessor;

    try {
      await expect(
        RuntimeProcessor.prototype.handleUploadBlob.call(processor, {
          type: RequestType.UploadBlob,
          space: "did:key:test-space" as never,
          contentType: "image/png",
          body: [1, 2, 3],
          suffix: "png",
        }),
      ).resolves.toEqual({
        id: "fid1:test",
        url: "http://toolshed.test/did:key:test-space/blobs/test.png",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toBe(
      "http://toolshed.test/did:key:test-space/blobs/upload.png",
    );
    // The host is resolved for the REQUEST's space, not any init space.
    expect(hostForSpaceCalls).toEqual(["did:key:test-space"]);
    expect(requestedPayload).toEqual({
      type: "image/png",
      body: new FabricBytes(new Uint8Array([1, 2, 3])),
    });
  });
});

describe("RuntimeProcessor home pattern IPC", () => {
  it("reconciles the home root when the update flag is enabled", () => {
    expect(shouldReconcileHomeRoot({ experimental: {} })).toBe(false);
    expect(shouldReconcileHomeRoot({
      experimental: { systemPatternAutoUpdate: false },
    })).toBe(false);
    expect(shouldReconcileHomeRoot({
      experimental: { systemPatternAutoUpdate: true },
    })).toBe(true);
  });

  it("uses the default-pattern metadata fast path when the home pattern is already instantiated", async () => {
    const defaultPatternRef: CellRef = {
      id: "of:default-pattern-result" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:default-pattern-source" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    let startedCell: unknown;
    let idleCalled = false;
    let defaultPatternSynced = false;

    const defaultPatternCell = {
      ...defaultPatternRef,
      getAsLink: () => cellRefToSigilLink(defaultPatternRef),
      getAsNormalizedFullLink: () => defaultPatternRef,
      getMetaRaw: (metaField: string) =>
        defaultPatternSynced && metaField === "pattern"
          ? cellRefToSigilLink(patternRef)
          : undefined,
      sync: () => {
        defaultPatternSynced = true;
        return Promise.resolve();
      },
    };
    const processor = {
      runtime: {
        getHomeSpaceCell: () => ({
          sync: () => Promise.resolve(),
          key: (key: string) => {
            expect(key).toBe("defaultPattern");
            return {
              get: () => ({
                resolveAsCell: () => defaultPatternCell,
              }),
            };
          },
        }),
        start: (cell: unknown) => {
          startedCell = cell;
          return Promise.resolve();
        },
        idle: () => {
          idleCalled = true;
          return Promise.resolve();
        },
      },
    } as unknown as RuntimeProcessor;

    await expect(
      RuntimeProcessor.prototype.handleEnsureHomePatternRunning.call(
        processor,
        { type: RequestType.EnsureHomePatternRunning },
      ),
    ).resolves.toEqual({ cell: defaultPatternRef });
    expect(startedCell).toBe(defaultPatternCell);
    expect(idleCalled).toBe(true);
  });

  it("routes an update-enabled home root through ensure before start", async () => {
    const defaultPatternRef: CellRef = {
      id: "of:update-enabled-home-root" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:update-enabled-home-pattern" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const defaultPatternCell = {
      ...defaultPatternRef,
      getAsLink: () => cellRefToSigilLink(defaultPatternRef),
      getMetaRaw: (metaField: string) =>
        metaField === "pattern" ? cellRefToSigilLink(patternRef) : undefined,
      sync: () => Promise.resolve(),
    };
    let startedDirectly = false;
    const runtime = {
      userIdentityDID: "did:key:test-home",
      experimental: { systemPatternAutoUpdate: true },
      getHomeSpaceCell: () => ({
        sync: () => Promise.resolve(),
        key: () => ({
          get: () => ({ resolveAsCell: () => defaultPatternCell }),
        }),
      }),
      storageManager: { synced: () => Promise.resolve() },
      start: () => {
        startedDirectly = true;
        return Promise.resolve(true);
      },
    };
    const processor = {
      identity: cfcSigner,
      runtime,
    } as unknown as RuntimeProcessor;

    const originalEnsure = PiecesController.prototype.ensureDefaultPattern;
    let ensured = false;
    PiecesController.prototype.ensureDefaultPattern = function () {
      ensured = true;
      return Promise.resolve({
        getCell: () => defaultPatternCell,
      } as unknown as Awaited<ReturnType<typeof originalEnsure>>);
    };
    try {
      await expect(
        RuntimeProcessor.prototype.handleEnsureHomePatternRunning.call(
          processor,
          { type: RequestType.EnsureHomePatternRunning },
        ),
      ).resolves.toEqual({ cell: defaultPatternRef });
    } finally {
      PiecesController.prototype.ensureDefaultPattern = originalEnsure;
    }

    expect(ensured).toBe(true);
    expect(startedDirectly).toBe(false);
  });
});

describe("system-pattern update wiring", () => {
  it("versionSkewNotification builds the worker→shell payload", () => {
    expect(
      versionSkewNotification({
        space: "did:key:z6Mk",
        clientVersion: "c",
        toolshedVersion: "t",
      }),
    ).toEqual({
      type: NotificationType.VersionSkew,
      space: "did:key:z6Mk",
      clientVersion: "c",
      toolshedVersion: "t",
    });
  });

  it("postVersionSkew posts the notification to the shell", () => {
    const posted: unknown[] = [];
    const orig = self.postMessage;
    (self as { postMessage: unknown }).postMessage = (m: unknown) =>
      posted.push(m);
    try {
      postVersionSkew({ space: "did:key:z6Mk", toolshedVersion: "t" });
    } finally {
      (self as { postMessage: unknown }).postMessage = orig;
    }
    expect(posted).toEqual([{
      type: NotificationType.VersionSkew,
      space: "did:key:z6Mk",
      clientVersion: undefined,
      toolshedVersion: "t",
    }]);
  });

  it("handleGetSpaceRootPattern returns the root ensured by the controller", async () => {
    const ref: CellRef = {
      id: "of:root-result" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const rootCell = { getAsLink: () => cellRefToSigilLink(ref) };
    const cc = {
      ensureDefaultPattern: () => Promise.resolve({ getCell: () => rootCell }),
    };
    const processor = {
      getSpaceCtx: () => ({ cc }),
    } as unknown as RuntimeProcessor;

    const result = await RuntimeProcessor.prototype.handleGetSpaceRootPattern
      .call(processor, {
        type: RequestType.GetSpaceRootPattern,
        space: "did:key:test-space",
      });
    expect(result.page.cell).toEqual(ref);
  });
});

describe("RuntimeProcessor CFC label IPC", () => {
  it('fails closed on the raw meta:"cfc" seam (inv-12 Stage 0 / SC-25)', () => {
    const ref: CellRef = {
      id: "of:cfc-raw-meta-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    // The raw envelope this seam used to return verbatim — Caveat.source and
    // friends, unredacted. If the handler ever reaches getMetaRaw for "cfc"
    // again, this is what would leak.
    const rawEnvelope = {
      version: 1,
      schemaHash: "test-schema",
      labelMap: {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.Caveat,
              kind: "derived-from",
              source: "did:key:alice",
            }],
          },
        }],
      },
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          get: () => "labelled data",
          getMetaRaw: () => rawEnvelope,
        }),
      },
    } as unknown as RuntimeProcessor;

    // "cfc" is no longer a MetaField, but the wire is untyped JSON — a request
    // that still sends it must get an error, never the raw metadata.
    expect(() =>
      RuntimeProcessor.prototype.handleCellGet.call(processor, {
        type: RequestType.CellGet,
        cell: ref,
        meta: "cfc" as never,
      })
    ).toThrow(/cfc/);
  });

  it("returns a label view for a cell ref", () => {
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          runtime: {
            readTx: () => ({
              readOrThrow: () => ({
                value: "labelled data",
                cfc: {
                  version: 1,
                  schemaHash: "test-schema",
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: [],
                      label: { confidentiality: ["prompt-risk"] },
                    }],
                  },
                },
              }),
            }),
          },
          getAsNormalizedFullLink: () => ref,
          getMetaRaw: () => undefined,
        }),
      },
    } as unknown as RuntimeProcessor;

    expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: ref,
      }),
    ).toEqual({
      cfcLabel: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: ["prompt-risk"] },
        }],
      },
    });
  });

  it("redacts Caveat.source from the introspection response (audit 28b)", async () => {
    const ref: CellRef = {
      id: "of:cfc-caveat-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          runtime: {
            readTx: () => ({
              readOrThrow: () => ({
                value: "labelled data",
                cfc: {
                  version: 1,
                  schemaHash: "test-schema",
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: [],
                      label: {
                        confidentiality: [{
                          type: CFC_ATOM_TYPE.Caveat,
                          kind: "derived-from",
                          source: "did:key:alice",
                        }],
                      },
                    }],
                  },
                },
              }),
            }),
          },
          getAsNormalizedFullLink: () => ref,
          getMetaRaw: () => undefined,
          sync: () => Promise.resolve(),
        }),
      },
    } as unknown as RuntimeProcessor;

    const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
      .call(
        processor,
        { type: RequestType.CellGetCfcLabel, cell: ref },
      );
    const atom = response.cfcLabel?.entries[0].label.confidentiality
      ?.[0] as Record<string, unknown>;
    // The caveat survives with its kind/type, but the source identity is gone.
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect(atom.kind).toBe("derived-from");
    expect("source" in atom).toBe(false);
  });

  // Inv-12 Stage 0, step 3: the display redaction applied to the top-level
  // cfcLabel at the three IPC response sites also covers the cfcLabelView
  // copies riding sigil links INSIDE response values (attached by
  // convertCellsToLinks includeCfcLabelView). Safe now that the worker
  // neither persists nor re-imports inbound views (steps 1–2).
  it("redacts Caveat.source in sigil label views inside handleCellGet values", () => {
    const ref: CellRef = {
      id: "of:cfc-value-view-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const linkWithView = {
      "/": {
        "link@1": {
          id: "of:cfc-value-view-linked",
          space: "did:key:test",
          path: [],
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.Caveat,
                  kind: "derived-from",
                  source: "did:key:alice",
                }],
              },
            }],
          },
        },
      },
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          get: () => ({ nested: linkWithView }),
        }),
      },
    } as unknown as RuntimeProcessor;

    const response = RuntimeProcessor.prototype.handleCellGet.call(processor, {
      type: RequestType.CellGet,
      cell: ref,
    });
    const responseLink = (response.value as {
      nested: {
        "/": {
          "link@1": {
            cfcLabelView: {
              entries: Array<
                { label: { confidentiality: Array<Record<string, unknown>> } }
              >;
            };
          };
        };
      };
    }).nested["/"]["link@1"];
    const atom = responseLink.cfcLabelView.entries[0].label.confidentiality[0];
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect(atom.kind).toBe("derived-from");
    expect("source" in atom).toBe(false);
  });

  it("redacts Caveat.source in sigil label views inside subscription updates", async () => {
    const ref: CellRef = {
      id: "of:cfc-subscribe-view-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object", additionalProperties: true },
    };
    const linkWithView = {
      "/": {
        "link@1": {
          id: "of:cfc-subscribe-view-linked",
          space: "did:key:test",
          path: [],
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.Caveat,
                  kind: "derived-from",
                  source: "did:key:alice",
                }],
              },
            }],
          },
        },
      },
    };
    const processor = {
      subscriptions: new Map(),
      runtime: {
        getCellFromLink: () => ({
          sink: (
            callback: (value: unknown, cfcLabel: unknown) => void,
          ) => {
            callback({ nested: linkWithView }, undefined);
            return () => {};
          },
        }),
      },
    } as unknown as RuntimeProcessor;

    const posted: Array<{ value?: unknown }> = [];
    const orig = self.postMessage;
    (self as { postMessage: unknown }).postMessage = (m: { value?: unknown }) =>
      posted.push(m);
    try {
      RuntimeProcessor.prototype.handleCellSubscribe.call(processor, {
        type: RequestType.CellSubscribe,
        cell: ref,
      });
      // The sink posts from a microtask.
      await Promise.resolve();
    } finally {
      (self as { postMessage: unknown }).postMessage = orig;
    }

    expect(posted.length).toBe(1);
    const notifiedLink = (posted[0].value as {
      nested: {
        "/": {
          "link@1": {
            cfcLabelView: {
              entries: Array<
                { label: { confidentiality: Array<Record<string, unknown>> } }
              >;
            };
          };
        };
      };
    }).nested["/"]["link@1"];
    const atom = notifiedLink.cfcLabelView.entries[0].label.confidentiality[0];
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect("source" in atom).toBe(false);
  });

  it("redacts Caveat.source in label views on response cell refs", () => {
    const sourceRef: CellRef = {
      id: "of:cfc-ref-view-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedRef: CellRef = {
      id: "of:cfc-ref-view-resolved" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedCell = {
      getAsLink: () => ({
        "/": {
          "link@1": resolvedRef,
        },
      }),
      getAsNormalizedFullLink: () => resolvedRef,
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            value: "resolved value",
            cfc: {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: {
                    confidentiality: [{
                      type: CFC_ATOM_TYPE.Caveat,
                      kind: "derived-from",
                      source: "did:key:alice",
                    }],
                  },
                }],
              },
            },
          }),
        }),
      },
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({ resolveAsCell: () => resolvedCell }),
      },
    } as unknown as RuntimeProcessor;

    const response = RuntimeProcessor.prototype.handleCellResolveAsCell.call(
      processor,
      { type: RequestType.CellResolveAsCell, cell: sourceRef },
    );
    const atom = response.cell.cfcLabelView?.entries[0].label
      .confidentiality?.[0] as Record<string, unknown>;
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect("source" in atom).toBe(false);
  });

  it("returns label views on resolved cell refs", () => {
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedRef: CellRef = {
      id: "of:cfc-label-resolved" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedCell = {
      getAsLink: () => ({
        "/": {
          "link@1": resolvedRef,
        },
      }),
      getAsNormalizedFullLink: () => resolvedRef,
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            value: "resolved value",
            cfc: {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { integrity: ["authored-by-bob"] },
                }],
              },
            },
          }),
        }),
      },
    };
    const sourceCell = {
      resolveAsCell: () => resolvedCell,
    };
    const processor = {
      runtime: {
        getCellFromLink: () => sourceCell,
      },
    } as unknown as RuntimeProcessor;

    expect(RuntimeProcessor.prototype.handleCellResolveAsCell.call(processor, {
      type: RequestType.CellResolveAsCell,
      cell: sourceRef,
    })).toEqual({
      cell: {
        ...resolvedRef,
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { integrity: ["authored-by-bob"] },
          }],
        },
      },
    });
  });

  it("does not look up CFC labels from a result meta cell", () => {
    const resultRef: CellRef = {
      id: "of:cfc-label-result" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    let resultSynced = false;
    let sourceSynced = false;
    const runtime = {
      readTx: () => ({
        readOrThrow: (address: { id: string }) =>
          address.id === sourceRef.id
            ? {
              value: "metadata cell",
              cfc: {
                version: 1,
                schemaHash: "test-schema",
                labelMap: {
                  version: 1,
                  entries: [{
                    path: [],
                    label: { confidentiality: ["source-label"] },
                  }],
                },
              },
            }
            : { value: "result cell" },
      }),
      getCellFromLink: (link: { id?: string }) =>
        link.id === sourceRef.id ? sourceCell : resultCell,
    };
    const sourceCell = {
      runtime,
      getAsNormalizedFullLink: () => sourceRef,
      getMetaRaw: (_metaField: string) => undefined,
      sync: () => {
        sourceSynced = true;
        return Promise.resolve();
      },
    };
    const resultCell = {
      runtime,
      getAsNormalizedFullLink: () => resultRef,
      resultRef,
      getMetaRaw: (metaField: string) =>
        resultSynced && metaField === "result"
          ? cellRefToSigilLink(sourceRef)
          : undefined,
      sync: () => {
        resultSynced = true;
        return Promise.resolve();
      },
    };
    const processor = { runtime } as unknown as RuntimeProcessor;

    expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: resultRef,
      }),
    ).toEqual({
      cfcLabel: undefined,
    });
    // getCfcLabel is a pure read: it never syncs (the reactive caller owns
    // liveness), and it reads only the cell's OWN stored label — it does not
    // follow the "result" meta link to pull CFC from a source/meta cell.
    expect(resultSynced).toBe(false);
    expect(sourceSynced).toBe(false);
  });

  it("reads the cell's own stored label without syncing (caller owns liveness)", () => {
    const ref: CellRef = {
      id: "of:cfc-label-pure-read" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    let synced = false;
    const cell = {
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            value: "labelled data",
            cfc: {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: ["result-label"] },
                }],
              },
            },
          }),
        }),
      },
      getAsNormalizedFullLink: () => ref,
      getMetaRaw: () => undefined,
      sync: () => {
        synced = true;
        return Promise.resolve();
      },
    };
    const processor = {
      runtime: { getCellFromLink: () => cell },
    } as unknown as RuntimeProcessor;

    expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: ref,
      }),
    ).toEqual({
      cfcLabel: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: ["result-label"] },
        }],
      },
    });
    // No sync: the label is read from the current store. A not-yet-loaded doc
    // would yield an empty label that self-heals when the reactive caller's
    // subscription delivers it.
    expect(synced).toBe(false);
  });

  it("ignores schema-bearing anyOf refs when reading nested stored labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const pieceSchema = {
        $ref: "#/$defs/TrustedMessage",
        $defs: {
          TrustedMessage: {
            anyOf: [
              { $ref: "#/$defs/TrustedMessageAlice" },
              { $ref: "#/$defs/TrustedMessageBob" },
            ],
          },
          TrustedMessageAlice: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["alice"],
              },
              body: { type: "string" },
            },
            required: ["id", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "alice",
              }],
            },
          },
          TrustedMessageBob: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["bob"],
              },
              body: { type: "string" },
            },
            required: ["id", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "bob",
              }],
            },
          },
        },
      } as const;
      const rootSchema = {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                piece: pieceSchema,
              },
              required: ["piece"],
            },
          },
        },
        required: ["messages"],
      } as const;

      const root = runtime.getCell(
        cfcSigner.did(),
        "cfc-label-repro",
        rootSchema,
      );
      const tx = runtime.edit() as any;
      tx.setCfcEnforcementMode("enforce-explicit");
      (root.withTx(tx) as any).set({
        messages: [{ piece: { id: "alice", body: "hello" } }],
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const replica = storageManager.open(cfcSigner.did())
        .replica as unknown as {
          getDocument(id: string): {
            value?: { messages?: unknown[] };
          } | undefined;
        };
      const rootId = parseLink(root.getAsLink()).id!;
      const nestedId = parseLink(
        replica.getDocument(rootId)?.value?.messages?.[0],
      )!.id!;
      const processor = { runtime } as unknown as RuntimeProcessor;

      const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
        .call(
          processor,
          {
            type: RequestType.CellGetCfcLabel,
            cell: {
              id: nestedId as CellRef["id"],
              space: cfcSigner.did() as CellRef["space"],
              scope: "space",
              path: ["piece"],
              schema: pieceSchema,
            },
          },
        );
      expect(response.cfcLabel).toBeDefined();
      expect(response.cfcLabel?.version).toBe(1);
      expect(response.cfcLabel?.entries).toEqual([{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reads nested stored labels after push when child refs rely on parent defs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const rootSchema = {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              $ref: "#/$defs/SharedMessageEntry",
            },
          },
        },
        required: ["messages"],
        $defs: {
          SharedMessageEntry: {
            type: "object",
            properties: {
              piece: {
                $ref: "#/$defs/TrustedMessage",
              },
            },
            required: ["piece"],
          },
          TrustedMessage: {
            anyOf: [
              { $ref: "#/$defs/TrustedMessageAlice" },
              { $ref: "#/$defs/TrustedMessageBob" },
            ],
          },
          TrustedMessageAlice: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["alice-message"],
              },
              author: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    enum: ["alice"],
                  },
                },
                required: ["id"],
              },
              body: { type: "string" },
            },
            required: ["id", "author", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "alice",
              }],
            },
          },
          TrustedMessageBob: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["bob-message"],
              },
              author: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    enum: ["bob"],
                  },
                },
                required: ["id"],
              },
              body: { type: "string" },
            },
            required: ["id", "author", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "bob",
              }],
            },
          },
        },
      } as const;

      const root = runtime.getCell(
        cfcSigner.did(),
        "cfc-label-parent-defs-push",
        rootSchema,
      );

      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      root.withTx(seed).set({ messages: [] });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      root.withTx(tx).key("messages").push({
        piece: {
          id: "alice-message",
          author: { id: "alice" },
          body: "hello",
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const replica = storageManager.open(cfcSigner.did())
        .replica as unknown as {
          getDocument(id: string): {
            value?: { messages?: unknown[] };
          } | undefined;
        };
      const rootId = parseLink(root.getAsLink()).id!;
      const nestedId = parseLink(
        replica.getDocument(rootId)?.value?.messages?.[0],
      )!.id!;
      const processor = { runtime } as unknown as RuntimeProcessor;

      const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
        .call(
          processor,
          {
            type: RequestType.CellGetCfcLabel,
            cell: {
              id: nestedId as CellRef["id"],
              space: cfcSigner.did() as CellRef["space"],
              scope: "space",
              path: ["piece"],
              schema: { $ref: "#/$defs/TrustedMessage" },
            },
          },
        );
      expect(response.cfcLabel).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{
              kind: "authored-by",
              subject: "alice",
            }],
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("RuntimeProcessor CFC commit preparation", () => {
  const ref: CellRef = {
    id: "of:cfc-client-write" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    scope: "space",
    path: [],
    schema: {
      type: "string",
      ifc: { confidentiality: ["client-write"] },
    },
  };

  const createProcessor = () => {
    let prepared = false;
    const tx = {
      commit: () => {
        expect(prepared).toBe(true);
        return Promise.resolve({ ok: {} });
      },
    };
    const cellWithTx = {
      set: (value: unknown) => {
        expect(value).toBe("new value");
      },
      send: (value: unknown) => {
        expect(value).toBe("new value");
      },
      // A blind `set` resolves the write target to thread its parent as the
      // structural precondition (see applyCellWrite).
      resolveAsCell: () => ({
        getAsNormalizedFullLink: () => ({
          id: ref.id,
          space: ref.space,
          scope: ref.scope,
          path: ref.path,
        }),
      }),
    };
    return {
      processor: {
        // handleCellSet/handleCellPush delegate to the shared applyCellWrite.
        applyCellWrite: RuntimeProcessor.prototype.applyCellWrite,
        runtime: {
          edit: () => tx,
          prepareTxForCommit: (candidate: unknown) => {
            expect(candidate).toBe(tx);
            prepared = true;
          },
          getCellFromLink: (candidate: unknown) => {
            expect(candidate).toBe(ref);
            return {
              withTx: (candidateTx: unknown) => {
                expect(candidateTx).toBe(tx);
                return cellWithTx;
              },
            };
          },
        },
      } as unknown as RuntimeProcessor,
    };
  };

  it("prepares cell set transactions before committing", async () => {
    const { processor } = createProcessor();

    await RuntimeProcessor.prototype.handleCellSet.call(processor, {
      type: RequestType.CellSet,
      cell: ref,
      value: "new value",
    });
  });

  it("prepares cell push transactions before committing (non-blind path)", async () => {
    const { processor } = createProcessor();

    await RuntimeProcessor.prototype.handleCellPush.call(processor, {
      type: RequestType.CellPush,
      cell: ref,
      value: "new value",
    });
  });

  it("prepares cell send transactions before committing", async () => {
    const { processor } = createProcessor();

    await RuntimeProcessor.prototype.handleCellSend.call(processor, {
      type: RequestType.CellSend,
      cell: ref,
      event: "new value",
    });
  });
});

describe("runtime-client CellRef conversion", () => {
  // Inv-12 Stage 0 (SC-25 prerequisite): a cfcLabelView riding an inbound
  // CellRef is a main-thread display artifact — round-tripped through
  // CellHandle.deserialize and back — and must not re-enter the worker as
  // label state. Forwarding it onto the written sigil link previously fed
  // recordLinkWritePolicyInput, whose entries prepareBoundaryCommit
  // persisted as link-origin labels; the worker now re-derives those from
  // its own stored source metadata instead.
  it("does not forward an inbound label view into worker sigil links", () => {
    const cfcLabelView: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { integrity: ["selected-by-alice"] },
      }],
    };
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:z6MkrX123abc" as CellRef["space"],
      scope: "space",
      path: ["value"],
      cfcLabelView,
    };

    expect(cellRefToSigilLink(ref)).toEqual({
      "/": {
        "link@1": {
          id: ref.id,
          space: ref.space,
          scope: "space",
          path: ref.path,
        },
      },
    });
  });

  it("does not seed worker cells from an inbound label view", () => {
    const cfcLabelView: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["main-thread-claim"] },
      }],
    };
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:z6MkrX123abc" as CellRef["space"],
      scope: "space",
      path: ["value"],
      cfcLabelView,
    };
    const seen: unknown[] = [];
    const runtime = {
      getCellFromLink: (...args: unknown[]) => {
        seen.push(args[3]);
        return {};
      },
    } as unknown as Runtime;

    getCell(runtime, ref);
    expect(seen).toEqual([undefined]);
  });

  // Raw sigil links inside inbound values (hand-crafted JSON, or a
  // CellHandle serialized into CustomEvent.detail via toJSON) bypass the
  // CellRef path — the value walker must drop their label views too
  // (codex/cubic review on the Stage 0 PR).
  it("strips label views from raw sigil links in inbound values", () => {
    const linkWithView = {
      "/": {
        "link@1": {
          id: "of:cfc-raw-link",
          space: "did:key:z6MkrX123abc",
          path: ["value"],
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: ["main-thread-claim"] },
            }],
          },
        },
      },
    };
    const mapped = mapCellRefsToSigilLinks({
      nested: [linkWithView],
    }) as { nested: Array<{ "/": { "link@1": Record<string, unknown> } }> };
    const payload = mapped.nested[0]["/"]["link@1"];
    expect(payload.id).toBe("of:cfc-raw-link");
    expect("cfcLabelView" in payload).toBe(false);
  });
});

describe("RuntimeProcessor VDom event label-view ingress", () => {
  // CustomEvent.detail is JSON.stringify'd on the main thread (invoking
  // CellHandle.toJSON) and re-enters the worker here, bypassing
  // getCell/cellRefToSigilLink — a handler writing event.detail.sourceCell
  // would persist the ref's view through the sigil-link write path. The
  // worker strips inbound views at this ingress too (codex/cubic review).
  it("strips label views from sigil links in inbound VDOM events", () => {
    const dispatched: unknown[] = [];
    const processor = {
      vdomMounts: new Map([[
        "mount-1",
        {
          reconciler: {
            dispatchEvent: (_handlerId: string, event: unknown) => {
              dispatched.push(event);
              return true;
            },
          },
        },
      ]]),
    } as unknown as RuntimeProcessor;

    RuntimeProcessor.prototype.handleVDomEvent.call(processor, {
      type: ClientNotificationType.VDomEvent,
      mountId: "mount-1",
      handlerId: "handler-1",
      event: {
        type: "drop",
        detail: {
          sourceCell: {
            "/": {
              "link@1": {
                id: "of:cfc-event-link",
                space: "did:key:z6MkrX123abc",
                path: ["value"],
                cfcLabelView: {
                  version: 1,
                  entries: [{
                    path: [],
                    label: { confidentiality: ["main-thread-claim"] },
                  }],
                },
              },
            },
          },
        },
      },
    } as never);

    expect(dispatched.length).toBe(1);
    const payload = (dispatched[0] as {
      detail: { sourceCell: { "/": { "link@1": Record<string, unknown> } } };
    }).detail.sourceCell["/"]["link@1"];
    expect(payload.id).toBe("of:cfc-event-link");
    expect("cfcLabelView" in payload).toBe(false);
  });
});

describe("RuntimeProcessor pattern coverage IPC", () => {
  const report = {
    spans: [{
      fileName: "/main.tsx",
      id: 1,
      kind: "runtime" as const,
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 2,
    }],
    hits: [{ fileName: "/main.tsx", id: 1, count: 3 }],
  };

  it("returns the worker collector's report", () => {
    const processor = {
      runtime: { patternCoverage: { toData: () => report } },
    } as unknown as RuntimeProcessor;
    expect(
      RuntimeProcessor.prototype.getPatternCoverage.call(processor, {
        type: RequestType.GetPatternCoverage,
      }),
    ).toEqual({ data: report });
  });

  it("reports null when the worker was built without a collector", () => {
    const processor = { runtime: {} } as unknown as RuntimeProcessor;
    expect(
      RuntimeProcessor.prototype.getPatternCoverage.call(processor, {
        type: RequestType.GetPatternCoverage,
      }),
    ).toEqual({ data: null });
  });

  it("routes a GetPatternCoverage request through the dispatcher", async () => {
    const processor = {
      runtime: { patternCoverage: { toData: () => report } },
      // handleRequest dispatches to this.getPatternCoverage; the stub carries
      // the real method so the routing case executes it.
      getPatternCoverage: RuntimeProcessor.prototype.getPatternCoverage,
    } as unknown as RuntimeProcessor;
    expect(
      await RuntimeProcessor.prototype.handleRequest.call(processor, {
        type: RequestType.GetPatternCoverage,
      }),
    ).toEqual({ data: report });
  });
});

describe("browserWorkerParamsFromInitializationData", () => {
  it("threads CFC initialization settings through the preset into runtime options", () => {
    const telemetry = { marker() {} } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[2];
    const storageManager = {
      as: { did: () => "did:key:worker" },
    } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[1];

    const options = runtimePresets.browserWorker(
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
          cfcEnforcementMode: "enforce-explicit",
          cfcFlowLabels: "observe",
          trustSnapshot: {
            id: "principal:did:key:worker",
            actingPrincipal: "did:key:worker",
          },
        },
        storageManager,
        telemetry,
      ),
    );

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.cfcFlowLabels).toBe("observe");
    expect(options.trustSnapshotProvider?.()).toEqual({
      id: "principal:did:key:worker",
      actingPrincipal: "did:key:worker",
    });
    // The preset pins patterns to the host's own API base.
    expect(options.patternEnvironment?.apiUrl.href).toBe("http://worker.test/");
  });

  it("threads clientVersion through to the runtime options", () => {
    const telemetry = { marker() {} } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[2];
    const storageManager = {
      as: { did: () => "did:key:worker" },
    } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[1];

    const withVersion = runtimePresets.browserWorker(
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
          clientVersion: "build-sha-xyz",
        },
        storageManager,
        telemetry,
      ),
    );
    expect(withVersion.clientVersion).toBe("build-sha-xyz");

    // Absent → omitted (rides the constructor default of undefined).
    const withoutVersion = runtimePresets.browserWorker(
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
        },
        storageManager,
        telemetry,
      ),
    );
    expect(withoutVersion.clientVersion).toBe(undefined);
  });

  it("falls back to the shared CFC pin when the host sends no dial", () => {
    const options = runtimePresets.browserWorker(
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
        },
        { as: { did: () => "did:key:worker" } } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[1],
        { marker() {} } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[2],
      ),
    );
    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.cfcFlowLabels).toBeUndefined();
  });

  it("threads the host-decided space-host map through to the runtime options", () => {
    const options = runtimePresets.browserWorker(
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
          spaceHostMap: { "did:key:federated": "http://other-host.test/" },
        },
        { as: { did: () => "did:key:worker" } } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[1],
        { marker() {} } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[2],
      ),
    );
    expect(options.spaceHostMap).toEqual({
      "did:key:federated": "http://other-host.test/",
    });
  });

  it("builds a fresh collector only when the host asks for coverage", () => {
    const storageManager = {
      as: { did: () => "did:key:worker" },
    } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[1];
    const telemetry = { marker() {} } as unknown as Parameters<
      typeof browserWorkerParamsFromInitializationData
    >[2];
    const params = (patternCoverage: boolean | undefined) =>
      browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
          ...(patternCoverage === undefined ? {} : { patternCoverage }),
        },
        storageManager,
        telemetry,
      );

    // On → a real collector the GetPatternCoverage handler can read back.
    const on = runtimePresets.browserWorker(params(true));
    expect(on.patternCoverage).toBeDefined();
    expect(typeof on.patternCoverage?.toData).toBe("function");

    // Off / absent → omitted, so the worker runs uninstrumented.
    expect(runtimePresets.browserWorker(params(false)).patternCoverage)
      .toBeUndefined();
    expect(runtimePresets.browserWorker(params(undefined)).patternCoverage)
      .toBeUndefined();
  });
});

// Federation PR2: one worker serves page operations for many spaces.
// getSpaceCtx resolves the per-space PieceManager/PiecesController,
// lazily for foreign spaces, over the shared runtime/storage.
describe("RuntimeProcessor per-space piece contexts", () => {
  const getSpaceCtx = (RuntimeProcessor.prototype as any).getSpaceCtx;

  async function makeProcessorState() {
    const { runtime } = createRuntime();
    const { PieceManager } = await import("@commonfabric/piece");
    const { PiecesController } = await import("@commonfabric/piece/ops");
    const homeSpace = cfcSigner.did();
    const pieceManager = new PieceManager(
      { as: cfcSigner, space: homeSpace },
      runtime,
    );
    const cc = new PiecesController(pieceManager);
    const processor = {
      runtime,
      identity: cfcSigner,
      space: homeSpace,
      spaces: new Map([[homeSpace, { pieceManager, cc }]]),
      pieceManager,
      cc,
      getSpaceCtx,
    };
    return { processor, runtime, homeSpace };
  }

  it("resolves the home space to the initialize-time context and rejects a missing space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    try {
      expect(processor.getSpaceCtx(homeSpace)).toBe(
        processor.spaces.get(homeSpace),
      );
      expect(processor.getSpaceCtx(homeSpace).pieceManager).toBe(
        processor.pieceManager,
      );
      expect(() =>
        (processor as { getSpaceCtx: (s?: string) => unknown })
          .getSpaceCtx()
      ).toThrow("name a space");
    } finally {
      await runtime.dispose();
    }
  });

  it("lazily builds a distinct, cached context for a foreign space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    try {
      const ctxB = processor.getSpaceCtx(spaceB);
      expect(ctxB.pieceManager).not.toBe(processor.pieceManager);
      expect(ctxB.pieceManager.getSpace()).toBe(spaceB);
      // Cached: the same context comes back, and the home context is intact.
      expect(processor.getSpaceCtx(spaceB)).toBe(ctxB);
      expect(processor.getSpaceCtx(homeSpace).pieceManager).toBe(
        processor.pieceManager,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("handlePageGet with a space resolves the page in that space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const handlePageGet = (RuntimeProcessor.prototype as any).handlePageGet;
    try {
      const resHome = await handlePageGet.call(processor, {
        type: RequestType.PageGet,
        pageId: fid("cross-space-probe"),
        runIt: false,
        space: homeSpace,
      });
      const resB = await handlePageGet.call(processor, {
        type: RequestType.PageGet,
        pageId: fid("cross-space-probe"),
        runIt: false,
        space: spaceB,
      });
      expect(resHome.page.cell.space).toBe(homeSpace);
      expect(resB.page.cell.space).toBe(spaceB);
    } finally {
      await runtime.dispose();
    }
  });

  it("handleRuntimeSynced awaits every opened space, naming none", async () => {
    const { processor, runtime } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const handleRuntimeSynced =
      (RuntimeProcessor.prototype as any).handleRuntimeSynced;
    try {
      processor.getSpaceCtx(spaceB);
      // Resolves across home + spaceB over loopback storage; the request
      // carries no space at all.
      await handleRuntimeSynced.call(processor);
    } finally {
      await runtime.dispose();
    }
  });

  it("handleIdle awaits commit-durability quiescence, not plain idle", async () => {
    // The client reads "idle" as a safe point to navigate or reload, so the
    // handler must await idleWithPendingCommits() — which includes in-flight
    // commit durability — rather than runtime.idle() (reactive quiescence
    // only). A fake exposing ONLY idleWithPendingCommits pins the wiring: a
    // regression to runtime.idle() throws here.
    const handleIdle = (RuntimeProcessor.prototype as any).handleIdle;
    let calls = 0;
    const fake = {
      runtime: {
        scheduler: {
          idleWithPendingCommits: () => {
            calls++;
            return Promise.resolve();
          },
        },
      },
    };
    await handleIdle.call(fake);
    expect(calls).toBe(1);
  });

  it("watchSiteTable registers table entries, isolating bad ones", async () => {
    const { runtime } = createRuntime();
    const { siteTableCause, siteTableSchema } = await import(
      "@commonfabric/home-schemas"
    );
    const registered: Array<[string, string]> = [];
    Object.assign(runtime, {
      registerSpaceHost: (space: string, host: string) => {
        registered.push([space, host]);
        // Malformed hosts throw in the real registry — simulate to
        // assert per-entry isolation.
        if (host === "not a url") throw new Error("Invalid host");
        return host !== "http://refused.test/";
      },
    });
    const userDid = runtime.userIdentityDID;
    const table = runtime.getCell(
      userDid,
      siteTableCause(userDid),
      siteTableSchema,
    );
    const tx = runtime.edit();
    table.withTx(tx).set([
      { did: "did:key:z6Mk-table-a", host: "http://host-a.test/" },
      { did: "not-a-did", host: "http://ignored.test/" },
      { did: "did:key:z6Mk-table-bad", host: "not a url" },
      { did: "did:key:z6Mk-table-b", host: "http://refused.test/" },
      { did: "did:key:z6Mk-table-c", host: "http://host-c.test/" },
    ]);
    await tx.commit();

    const processor = { runtime } as unknown as RuntimeProcessor;
    try {
      (RuntimeProcessor.prototype as unknown as {
        watchSiteTable(): void;
      }).watchSiteTable.call(processor);
      await runtime.idle();
      // Microtask drain: sync() resolution + first sink fire.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(registered).toEqual([
        ["did:key:z6Mk-table-a", "http://host-a.test/"],
        ["did:key:z6Mk-table-bad", "not a url"],
        ["did:key:z6Mk-table-b", "http://refused.test/"],
        ["did:key:z6Mk-table-c", "http://host-c.test/"],
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("handleRegisterSpaceHost forwards to the runtime and reports the verdict", () => {
    const calls: Array<[string, string]> = [];
    const processor = {
      runtime: {
        registerSpaceHost: (space: string, host: string) => {
          calls.push([space, host]);
          return host === "http://accepted.test/";
        },
      },
    } as unknown as RuntimeProcessor;
    const handle = (RuntimeProcessor.prototype as unknown as {
      handleRegisterSpaceHost(
        r: { type: RequestType; space: string; host: string },
      ): { value: boolean };
    }).handleRegisterSpaceHost;
    expect(handle.call(processor, {
      type: RequestType.RegisterSpaceHost,
      space: "did:key:z6Mk-ipc-a",
      host: "http://accepted.test/",
    })).toEqual({ value: true });
    expect(handle.call(processor, {
      type: RequestType.RegisterSpaceHost,
      space: "did:key:z6Mk-ipc-b",
      host: "http://refused.test/",
    })).toEqual({ value: false });
    expect(calls.length).toBe(2);
  });

  it("managerFor returns only existing contexts (no lazy create)", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const managerFor = (RuntimeProcessor.prototype as any).managerFor;
    try {
      expect(managerFor.call(processor, homeSpace)).toBe(
        processor.pieceManager,
      );
      expect(managerFor.call(processor, spaceB)).toBeUndefined();
      const ctxB = processor.getSpaceCtx(spaceB);
      expect(managerFor.call(processor, spaceB)).toBe(ctxB.pieceManager);
    } finally {
      await runtime.dispose();
    }
  });
});

// S16 phase D: the host's render confidentiality ceiling must reach every
// mount's reconciler — a ceiling configured at initialization that never
// arrives at the egress surface is silently unbounded rendering.
describe("RuntimeProcessor vdom mount render policy", () => {
  const handleVDomMount = (RuntimeProcessor.prototype as any).handleVDomMount;
  const handleVDomUnmount =
    (RuntimeProcessor.prototype as any).handleVDomUnmount;

  type RootRenderPolicy = {
    maxConfidentiality?: readonly unknown[];
    caveatKindAllow?: readonly string[];
  };

  async function mountAndGetRootPolicy(
    renderConfidentialityCeiling:
      | { atoms?: unknown[]; caveatKinds?: string[] }
      | undefined,
  ): Promise<RootRenderPolicy> {
    const { runtime } = createRuntime();
    const space = cfcSigner.did();
    const tx = runtime.edit();
    const cell = runtime.getCell<string>(
      space,
      "vdom-mount-render-policy",
      undefined,
      tx,
    );
    cell.set("hello");
    const commit = await tx.commit();
    expect(commit.ok !== undefined).toBe(true);

    const state = {
      runtime,
      vdomMounts: new Map<
        number,
        { reconciler: unknown; cancel: () => void }
      >(),
      vdomBatchIdCounter: 0,
      renderDeclassificationPolicy: "allow",
      renderConfidentialityCeiling,
      handleVDomUnmount,
    };
    // handleVDomMount's onOps/onError callbacks post to the worker scope;
    // stub postMessage for the main-thread test.
    const hadPostMessage = "postMessage" in globalThis;
    const originalPostMessage = (globalThis as any).postMessage;
    (globalThis as any).postMessage = () => {};
    try {
      handleVDomMount.call(state, {
        type: RequestType.VDomMount,
        mountId: 1,
        cell: cell.getAsNormalizedFullLink() as unknown as CellRef,
      });
      const mount = state.vdomMounts.get(1);
      expect(mount).toBeDefined();
      const policy = (mount!.reconciler as { rootRenderPolicy?: unknown })
        .rootRenderPolicy as RootRenderPolicy;
      handleVDomUnmount.call(state, {
        type: RequestType.VDomUnmount,
        mountId: 1,
      });
      return policy;
    } finally {
      // Reconciler flushes are queueMicrotask batches, so everything queued
      // by mount/unmount fires before this await's continuation — restoring
      // postMessage after it means the stub is in place through the last
      // flush, with no timer heuristics.
      await runtime.dispose();
      if (hadPostMessage) {
        (globalThis as any).postMessage = originalPostMessage;
      } else {
        delete (globalThis as any).postMessage;
      }
    }
  }

  it("threads the configured ceiling into each mount's reconciler", async () => {
    const userAtom = {
      type: "https://commonfabric.org/cfc/atom/Resource",
      class: "ActingUser",
      subject: cfcSigner.did(),
    };
    const caveatKind = "https://commonfabric.org/cfc/concepts/prompt-influence";
    const policy = await mountAndGetRootPolicy({
      atoms: [userAtom],
      caveatKinds: [caveatKind],
    });
    expect(policy.maxConfidentiality).toEqual([userAtom]);
    expect(policy.caveatKindAllow).toEqual([caveatKind]);
  });

  it("keeps mounts unbounded when no ceiling is configured", async () => {
    const policy = await mountAndGetRootPolicy(undefined);
    expect(policy.maxConfidentiality).toBeUndefined();
  });
});

// handleVDomEvent forwards a main-thread DOM event to the owning mount's
// reconciler. The reconciler's dispatchEvent returns false when no handler is
// registered for the handlerId, meaning the event was dropped. The processor
// surfaces that drop as a console.warn carrying the mountId and handlerId so a
// silently-dropped click is traceable.
describe("RuntimeProcessor handleVDomEvent dropped-event warning", () => {
  const handleVDomEvent = (RuntimeProcessor.prototype as any).handleVDomEvent;

  function makeState(dispatchResult: boolean, calls: unknown[][]) {
    return {
      vdomMounts: new Map<number, { reconciler: unknown }>([
        [
          7,
          {
            reconciler: {
              dispatchEvent(handlerId: number, event: unknown): boolean {
                calls.push([handlerId, event]);
                return dispatchResult;
              },
            },
          },
        ],
      ]),
    };
  }

  function captureWarn(run: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      run();
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  it("warns with mountId and handlerId when the handler is missing", () => {
    const calls: unknown[][] = [];
    const state = makeState(false, calls);
    const warnings = captureWarn(() =>
      handleVDomEvent.call(state, {
        type: ClientNotificationType.VDomEvent,
        mountId: 7,
        handlerId: 42,
        event: { type: "click" },
        nodeId: 3,
      })
    );
    expect(calls).toEqual([[42, { type: "click" }]]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("No handler found for mountId: 7");
    expect(warnings[0]).toContain("handlerId: 42");
  });

  it("does not warn when the reconciler dispatches the event", () => {
    const calls: unknown[][] = [];
    const state = makeState(true, calls);
    const warnings = captureWarn(() =>
      handleVDomEvent.call(state, {
        type: ClientNotificationType.VDomEvent,
        mountId: 7,
        handlerId: 99,
        event: { type: "input" },
        nodeId: 5,
      })
    );
    expect(calls).toEqual([[99, { type: "input" }]]);
    expect(warnings.length).toBe(0);
  });

  it("warns when no mount exists for the event's mountId", () => {
    const calls: unknown[][] = [];
    const state = makeState(true, calls);
    const warnings = captureWarn(() =>
      handleVDomEvent.call(state, {
        type: ClientNotificationType.VDomEvent,
        mountId: 404,
        handlerId: 1,
        event: { type: "click" },
        nodeId: 0,
      })
    );
    expect(calls).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("No mount found for mountId: 404");
  });
});

describe("RuntimeProcessor.handleNotification", () => {
  // Base the fake on the real prototype so handleNotification's delegation to
  // handleVDomEvent / handleVDomBatchApplied resolves, while vdomMounts is a
  // stub that records what the reconciler is asked to do.
  function fakeProcessor() {
    const events: Array<{ handlerId: number; event: unknown }> = [];
    const acks: number[] = [];
    const processor = Object.create(
      RuntimeProcessor.prototype,
    ) as RuntimeProcessor;
    (processor as unknown as { vdomMounts: unknown }).vdomMounts = new Map([[
      1,
      {
        reconciler: {
          dispatchEvent: (handlerId: number, event: unknown) =>
            events.push({ handlerId, event }),
          acknowledgeBatchApplied: (batchId: number) => acks.push(batchId),
        },
      },
    ]]);
    return { processor, events, acks };
  }

  it("routes a VDomEvent notification to the mount's reconciler", () => {
    const { processor, events } = fakeProcessor();
    processor.handleNotification({
      type: ClientNotificationType.VDomEvent,
      mountId: 1,
      handlerId: 7,
      event: { type: "click" } as never,
      nodeId: 3,
    });
    expect(events).toEqual([{ handlerId: 7, event: { type: "click" } }]);
  });

  it("routes a VDomBatchApplied notification to the mount's reconciler", () => {
    const { processor, acks } = fakeProcessor();
    processor.handleNotification({
      type: ClientNotificationType.VDomBatchApplied,
      mountId: 1,
      batchId: 42,
    });
    expect(acks).toEqual([42]);
  });

  it("warns on an unknown notification type without throwing", () => {
    const { processor, events, acks } = fakeProcessor();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      processor.handleNotification({ type: "vdom:bogus", mountId: 1 } as never);
    } finally {
      console.warn = original;
    }
    expect(warnings.length).toBe(1);
    expect(events).toEqual([]);
    expect(acks).toEqual([]);
  });
});
