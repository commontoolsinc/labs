import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  isValidFabricValue,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import { entityRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { getLogger } from "@commonfabric/utils/logger";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  eventAttentionEntryKey,
  eventAttentionIndexKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  type SqliteDbRef,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { siteTableCause, siteTableSchema } from "@commonfabric/home-schemas";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  entityIdFrom,
  popFrame,
  pushFrame,
  Runtime,
  type RuntimeFetch,
  runtimePresets,
  RuntimeTelemetry,
  type SigilLink,
} from "@commonfabric/runner";
import {
  atomsOutsideCeiling,
  cfcLabelViewForCell,
  linkCfcLabelView,
  setLinkCfcLabelView,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { StorageManager as WorkerStorageManager } from "@commonfabric/runner/storage/cache";

import { parseLink } from "@commonfabric/runner";
import * as V2Storage from "@commonfabric/runner/storage/v2";
import { CompilerStackLoadError } from "@commonfabric/runner";
import {
  type CellRef,
  type CfcLabelView,
  ClientNotificationType,
  type GetPatternSourcesRequest,
  NotificationType,
  RequestType,
  RuntimeErrorCode,
} from "@/protocol/mod.ts";
import {
  assertServerExecutionPostureAgreement,
  browserWorkerParamsFromInitializationData,
  mountErrorSink,
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  RuntimeProcessor,
  subscribeEventAttentionNotifications,
  toConsoleDebugValue,
} from "@/backends/runtime-processor.ts";
import {
  assertFabricLoggerFlags,
  cellRefToSigilLink,
  createCellRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "@/backends/utils.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";

const cfcSigner = await Identity.fromPassphrase(
  "runtime-processor-cfc-label-tests",
);
const testSessionOpenAudience = "did:key:z6Mk-runtime-processor-test-audience";

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
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
// their context is always the home pieces controller.
function homeSpaceCtx(this: { cc?: unknown }) {
  return this.cc;
}

// A valid `fid1:` page id from a readable seed (handlers parse pageId via
// `entityIdFrom`, which requires a real tagged-hash string).
const fid = (seed: string) => taggedHashStringOf(seed);

describe("runtime-processor", () => {
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
            resolver!({
              confidentiality: [cfcAtom.space("did:key:z6MkThird")],
            }),
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
        //
        // Seeded as a path-`[]` full-document write — the shape hydration
        // delivers, and the one `ACLManager` uses. A value-surface write is
        // decomposed into `op: "patch"`, which the memory server refuses for the
        // ACL document (INV-12), so the runner's write chokepoint rejects it.
        const tx = runtime.edit();
        tx.writeOrThrow({
          space: grantedSpace as MemorySpace,
          id: `of:${grantedSpace}` as URI,
          type: "application/json",
          path: [],
        }, {
          value: {
            [grantedSpace]: "OWNER",
            [cfcSigner.did()]: "READ",
          },
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
        // Path-`[]` full-document write: the ACL document's required write shape
        // (INV-12). See the note in the resolver test above.
        const tx = runtime.edit();
        tx.writeOrThrow({
          space: grantedSpace as MemorySpace,
          id: `of:${grantedSpace}` as URI,
          type: "application/json",
          path: [],
        }, {
          value: {
            [grantedSpace]: "OWNER",
            [cfcSigner.did()]: "READ",
          },
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
        expect(provider!.readerRole("did:key:z6MkNoAclProviderTest"))
          .toBeNull();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("piece source state", () => {
    it("reads the piece named by the request, in that request's space", async () => {
      const space = "did:key:z6Mk-runtime-processor-source" as const;
      const synced: string[] = [];
      const readFor: unknown[] = [];
      const cell = {
        space,
        sync: () => {
          synced.push("cell");
          return Promise.resolve();
        },
        // A piece with no metadata at all: the reader's own behavior on each
        // field is covered in packages/piece; this asserts the addressing.
        getMetaRaw: () => undefined,
        getAsNormalizedFullLink: () => ({ id: "of:fid1:sourced" }),
        asSchema: () => ({ get: () => ({}) }),
      };
      const processor = {
        getSpaceCtx: (requested: string) => ({ getSpace: () => requested }),
        runtime: {
          // Stands in for readPieceSourceState's reads: the handler's own job is
          // to address the right cell and hand back what the reader produced.
          getCellFromEntityId: (
            requestedSpace: string,
            entityId: unknown,
          ) => {
            readFor.push({ space: requestedSpace, entityId: String(entityId) });
            return cell;
          },
          patternManager: {
            getPatternSourceProgramByIdentity: () => Promise.resolve(undefined),
          },
          hostForSpace: () => new URL("https://toolshed.test"),
        },
      };

      const result = await (RuntimeProcessor.prototype as any)
        .handlePieceGetSource.call(processor, {
          type: RequestType.PieceGetSource,
          space,
          pieceId: fid("sourced-piece"),
        });

      expect(synced).toEqual(["cell"]);
      // The handler addresses the cell by the entity id `entityIdFrom` builds
      // from the routing form of the request's pieceId. That is a FabricHash, and
      // its string form is the tagged hash — the `of:` scheme is added later, by
      // the `getCellFromEntityId` this stub stands in for.
      expect(readFor).toEqual([{
        space,
        entityId: String(entityIdFrom(fid("sourced-piece"))),
      }]);
      // The reader saw a piece with no metadata at all, which is a detached piece
      // with no readable source — reported as such rather than as a failure.
      expect(result.source.origin).toBeUndefined();
      expect(result.source.files).toEqual([]);
      expect(result.source.history).toEqual([]);
    });

    it("rejects an unknown compatibility confirmation before changing a piece", async () => {
      const space = "did:key:z6Mk-runtime-processor-source" as const;
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        pieceSourceConfirmations: new Map(),
      };

      await expect(
        (RuntimeProcessor.prototype as any).handlePieceUpdateSource.call(
          processor,
          {
            type: RequestType.PieceUpdateSource,
            space,
            pieceId: fid("sourced-piece"),
            action: { kind: "restore", revisionId: "older" },
            confirmationToken: "unknown-confirmation",
          },
        ),
      ).rejects.toThrow(
        "the piece source compatibility confirmation is no longer valid",
      );
    });

    it("rejects empty and non-string compatibility confirmations", async () => {
      for (const confirmationToken of ["", 42]) {
        await expect(
          (RuntimeProcessor.prototype as any).handlePieceUpdateSource.call(
            { pieceSourceConfirmations: new Map() },
            {
              type: RequestType.PieceUpdateSource,
              space: "did:key:z6Mk-runtime-processor-source",
              pieceId: fid("sourced-piece"),
              action: { kind: "restore", revisionId: "older" },
              confirmationToken,
            },
          ),
        ).rejects.toThrow("confirmationToken must be a non-empty string");
      }
    });

    it("issues one-use confirmation tokens for incompatible source changes", async () => {
      const space = "did:key:z6Mk-runtime-processor-source" as const;
      const pieceId = fid("sourced-piece");
      const cell = {
        space,
        entityId: entityRefFrom(entityIdFrom(pieceId)),
        sync: () => Promise.resolve(),
        getMetaRaw: () => undefined,
        getAsNormalizedFullLink: () => ({ id: `of:${pieceId}`, path: [] }),
        asSchema: () => ({ get: () => ({}) }),
      };
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        pieceSourceConfirmations: new Map(),
        runtime: {
          getCellFromEntityId: () => cell,
          patternManager: {
            getPatternSourceProgramByIdentity: () => Promise.resolve(undefined),
          },
          hostForSpace: () => new URL("https://toolshed.test"),
        },
      };
      const action = { kind: "restore", revisionId: "older" } as const;
      const prepared = {
        action,
        expected: {
          pattern: { identity: "current", symbol: "default" },
          origin: null,
          revisionId: "current",
        },
        candidate: { identity: "older", symbol: "default" },
        origin: null,
        operation: "revert",
        baseline: { kind: "retain", revisionId: "baseline" },
        review: {
          argumentEvidence: "argument",
          issues: { schema: "narrowed" },
        },
      };
      let receivedConfirmation: unknown;
      let calls = 0;
      const changeSource = PieceController.prototype.changeSource;
      PieceController.prototype.changeSource = ((_action, options) => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            status: "incompatible",
            message: "result schema narrowed",
            prepared,
          });
        }
        receivedConfirmation = options?.confirmedChange;
        return Promise.resolve({ status: "applied" });
      }) as typeof changeSource;

      try {
        const first = await (RuntimeProcessor.prototype as any)
          .handlePieceUpdateSource.call(processor, {
            type: RequestType.PieceUpdateSource,
            space,
            pieceId,
            action,
          });
        expect(first.compatibilityWarning).toBe("result schema narrowed");
        expect(first.confirmationToken).toBeDefined();
        expect(processor.pieceSourceConfirmations.size).toBe(1);

        const second = await (RuntimeProcessor.prototype as any)
          .handlePieceUpdateSource.call(processor, {
            type: RequestType.PieceUpdateSource,
            space,
            pieceId,
            action,
            confirmationToken: first.confirmationToken,
          });
        expect(receivedConfirmation).toBe(prepared);
        expect(second.compatibilityWarning).toBeUndefined();
        expect(processor.pieceSourceConfirmations.size).toBe(0);

        await expect(
          (RuntimeProcessor.prototype as any).handlePieceUpdateSource.call(
            processor,
            {
              type: RequestType.PieceUpdateSource,
              space,
              pieceId,
              action,
              confirmationToken: first.confirmationToken,
            },
          ),
        ).rejects.toThrow(
          "the piece source compatibility confirmation is no longer valid",
        );
      } finally {
        PieceController.prototype.changeSource = changeSource;
      }
    });

    it("does not hide a source-read failure for an incompatible change", async () => {
      const space = "did:key:z6Mk-runtime-processor-source" as const;
      const pieceId = fid("sourced-piece");
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        pieceSourceConfirmations: new Map(),
        runtime: {
          getCellFromEntityId: () => ({
            space,
            entityId: entityRefFrom(entityIdFrom(pieceId)),
            sync: () => Promise.reject("source read failed"),
            getMetaRaw: () => undefined,
            getAsNormalizedFullLink: () => ({ id: `of:${pieceId}`, path: [] }),
            asSchema: () => ({ get: () => ({}) }),
          }),
        },
      };
      const changeSource = PieceController.prototype.changeSource;
      PieceController.prototype.changeSource = (() =>
        Promise.resolve({
          status: "incompatible",
          message: "result schema narrowed",
          prepared: {},
        })) as unknown as typeof changeSource;

      let reason: unknown;
      try {
        await (RuntimeProcessor.prototype as any).handlePieceUpdateSource.call(
          processor,
          {
            type: RequestType.PieceUpdateSource,
            space,
            pieceId,
            action: { kind: "restore", revisionId: "older" },
          },
        );
      } catch (error) {
        reason = error;
      } finally {
        PieceController.prototype.changeSource = changeSource;
      }
      expect(reason).toBe("source read failed");
    });

    it("preserves an applied result when source-detail refresh fails", async () => {
      const storageManager = StorageManager.emulate({ as: cfcSigner });
      const runtime = new Runtime({
        apiUrl: new URL("https://toolshed.test"),
        storageManager,
      });
      const space = cfcSigner.did();
      const cell = runtime.getCell(space, "source-refresh-failure");
      await cell.sync();
      const sync = cell.sync.bind(cell);
      cell.sync = () => Promise.reject(new Error("refresh unavailable"));
      const getCellFromEntityId = runtime.getCellFromEntityId.bind(runtime);
      runtime.getCellFromEntityId = (() => cell) as typeof getCellFromEntityId;
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        pieceSourceConfirmations: new Map(),
        runtime,
      };
      const changeSource = PieceController.prototype.changeSource;
      PieceController.prototype.changeSource =
        (() => Promise.resolve({ status: "applied" })) as typeof changeSource;
      try {
        const result = await (RuntimeProcessor.prototype as any)
          .handlePieceUpdateSource.call(processor, {
            type: RequestType.PieceUpdateSource,
            space,
            pieceId: fid("sourced-piece"),
            action: { kind: "detach" },
          });

        expect(result.source.history).toEqual([]);
        expect(result.executionWarning).toContain(
          "source details could not be refreshed: refresh unavailable",
        );
      } finally {
        PieceController.prototype.changeSource = changeSource;
        cell.sync = sync;
        runtime.getCellFromEntityId = getCellFromEntityId;
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("piece creation", () => {
    it("names the rejected argument rather than its type", async () => {
      // A piece's input is a record, and the guard turns away everything else.
      // `typeof` is not what says which: it renders an array and `null` alike,
      // as `object`, and those are two of the three kinds that get here. The
      // message exists to explain the refusal, so it names the value.

      const space = "did:key:z6Mk-runtime-processor-create" as const;
      const processor = { getSpaceCtx: () => ({}) };
      const refusalFor = async (argument: unknown) => {
        try {
          // deno-lint-ignore no-explicit-any
          await (RuntimeProcessor.prototype as any).handlePieceCreate.call(
            processor,
            {
              type: RequestType.PageCreate,
              space,
              source: { program: { main: "/main.tsx", files: [] } },
              argument,
            },
          );
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error("handlePieceCreate returned instead of refusing");
      };

      expect(await refusalFor([1, 2]))
        .toBe("A piece's argument must be a record, not: [1,2]");
      expect(await refusalFor(null))
        .toBe("A piece's argument must be a record, not: null");
      expect(await refusalFor("a bare string"))
        .toBe('A piece\'s argument must be a record, not: "a bare string"');
    });

    it("refuses a fabric class instance as the whole argument", async () => {
      // The arm that separates `isPlainObject()` from the looser
      // `isObjectNotArray()`, which admits any class instance. The connection
      // carries a `FabricBytes` whole, so one reaches this guard as itself
      // rather than as the `{}` a shape-blind copy would leave -- and a piece's
      // entire input is not one value, whatever that value is.

      const space = "did:key:z6Mk-runtime-processor-create" as const;
      const processor = { getSpaceCtx: () => ({}) };

      await expect(
        // deno-lint-ignore no-explicit-any
        (RuntimeProcessor.prototype as any).handlePieceCreate.call(processor, {
          type: RequestType.PageCreate,
          space,
          source: { program: { main: "/main.tsx", files: [] } },
          argument: new FabricBytes(new Uint8Array([1, 2, 3])),
        }),
      ).rejects.toThrow("A piece's argument must be a record, not:");

      // The other branch of the fabric class hierarchy, which reaches the
      // guard by the same route.
      await expect(
        // deno-lint-ignore no-explicit-any
        (RuntimeProcessor.prototype as any).handlePieceCreate.call(processor, {
          type: RequestType.PageCreate,
          space,
          source: { program: { main: "/main.tsx", files: [] } },
          argument: new FabricError({
            type: "Error",
            message: "not a set of inputs",
            stack: undefined,
            cause: undefined,
          }),
        }),
      ).rejects.toThrow("A piece's argument must be a record, not:");
    });

    it("admits a record that holds a fabric class instance", async () => {
      // The other side of the same line, and the case that has to keep
      // working: the guard asks what the argument *is*, not what it holds.

      const space = "did:key:z6Mk-runtime-processor-create" as const;
      const created: unknown[] = [];
      const processor = {
        getSpaceCtx: () => ({
          create: (_program: unknown, options: { input?: unknown }) => {
            created.push(options.input);
            throw new Error("stop after the guard");
          },
        }),
      };
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      await expect(
        // deno-lint-ignore no-explicit-any
        (RuntimeProcessor.prototype as any).handlePieceCreate.call(processor, {
          type: RequestType.PageCreate,
          space,
          source: { program: { main: "/main.tsx", files: [] } },
          argument: { image: bytes },
        }),
      ).rejects.toThrow("stop after the guard");
      expect(created).toEqual([{ image: bytes }]);
    });
  });

  describe("space ACL state", () => {
    it("reports owner controls from the active principal's ACL entry", async () => {
      const space = "did:key:z6Mk-runtime-processor-acl" as const;
      const owner = "did:key:z6Mk-runtime-processor-owner" as const;
      const runtime = {
        userIdentityDID: owner,
        storageManager: { synced: () => Promise.resolve() },
        getCellFromLink: () => ({
          sync: () => Promise.resolve(),
          get: () => ({ [owner]: "OWNER", "*": "WRITE" }),
        }),
      };
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        runtime,
      };

      const response = await (RuntimeProcessor.prototype as any)
        .handleSpaceGetAcl.call(processor, {
          type: RequestType.SpaceGetAcl,
          space,
        });

      expect(response.access).toEqual({
        space,
        principal: owner,
        acl: { [owner]: "OWNER", "*": "WRITE" },
        canEdit: true,
      });
    });

    it("keeps wildcard writers read-only in the ACL view", async () => {
      const space = "did:key:z6Mk-runtime-processor-acl" as const;
      const owner = "did:key:z6Mk-runtime-processor-owner" as const;
      const writer = "did:key:z6Mk-runtime-processor-writer" as const;
      const processor = {
        getSpaceCtx: () => ({ getSpace: () => space }),
        runtime: {
          userIdentityDID: writer,
          storageManager: { synced: () => Promise.resolve() },
          getCellFromLink: () => ({
            sync: () => Promise.resolve(),
            get: () => ({ [owner]: "OWNER", "*": "WRITE" }),
          }),
        },
      };

      const response = await (RuntimeProcessor.prototype as any)
        .handleSpaceGetAcl.call(processor, {
          type: RequestType.SpaceGetAcl,
          space,
        });

      expect(response.access.canEdit).toBe(false);
    });

    it("routes valid ACL mutations and returns each committed ACL", async () => {
      const { runtime, storageManager } = createRuntime();
      const space =
        "did:key:z6Mk-runtime-processor-acl-mutations" as MemorySpace;
      const owner = cfcSigner.did();
      const writer = "did:key:z6Mk-runtime-processor-added-writer" as const;
      try {
        const tx = runtime.edit();
        tx.writeOrThrow({
          space,
          id: `of:${space}` as URI,
          type: "application/json",
          path: [],
        }, {
          value: { [owner]: "OWNER", "*": "READ" },
        });
        await tx.commit();
        await runtime.idle();
        await storageManager.synced();

        const processor = {
          runtime,
          getSpaceCtx: () => ({ getSpace: () => space }),
          handleSpaceGetAcl: RuntimeProcessor.prototype.handleSpaceGetAcl,
          handleSpaceSetAclEntry:
            RuntimeProcessor.prototype.handleSpaceSetAclEntry,
          handleSpaceRemoveAclEntry:
            RuntimeProcessor.prototype.handleSpaceRemoveAclEntry,
        } as unknown as RuntimeProcessor;

        const added = await RuntimeProcessor.prototype.handleRequest.call(
          processor,
          {
            type: RequestType.SpaceSetAclEntry,
            space,
            user: writer,
            capability: "WRITE",
          },
        );
        expect(added).toEqual({
          access: {
            space,
            principal: owner,
            acl: { [owner]: "OWNER", "*": "READ", [writer]: "WRITE" },
            canEdit: true,
          },
        });

        const read = await RuntimeProcessor.prototype.handleRequest.call(
          processor,
          { type: RequestType.SpaceGetAcl, space },
        );
        expect(read).toEqual(added);

        const removed = await RuntimeProcessor.prototype.handleRequest.call(
          processor,
          {
            type: RequestType.SpaceRemoveAclEntry,
            space,
            user: writer,
          },
        );
        expect(removed).toEqual({
          access: {
            space,
            principal: owner,
            acl: { [owner]: "OWNER", "*": "READ" },
            canEdit: true,
          },
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects malformed ACL mutations before opening the space", async () => {
      const processor = {
        getSpaceCtx: () => {
          throw new Error("space must not be opened");
        },
      };

      await expect(
        (RuntimeProcessor.prototype as any).handleSpaceSetAclEntry.call(
          processor,
          {
            type: RequestType.SpaceSetAclEntry,
            space: "did:key:z6Mk-runtime-processor-acl",
            user: "not-a-did",
            capability: "WRITE",
          },
        ),
      ).rejects.toThrow("user must be `*` or a valid DID");
      await expect(
        (RuntimeProcessor.prototype as any).handleSpaceSetAclEntry.call(
          processor,
          {
            type: RequestType.SpaceSetAclEntry,
            space: "did:key:z6Mk-runtime-processor-acl",
            user: "did:key:z6Mk-runtime-processor-reader",
            capability: "ADMIN",
          },
        ),
      ).rejects.toThrow("capability must be `READ`, `WRITE`, or `OWNER`");
      await expect(
        (RuntimeProcessor.prototype as any).handleSpaceRemoveAclEntry.call(
          processor,
          {
            type: RequestType.SpaceRemoveAclEntry,
            space: "did:key:z6Mk-runtime-processor-acl",
            user: "not-a-did",
          },
        ),
      ).rejects.toThrow("user must be `*` or a valid DID");
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
        cc: {
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
        cc: {
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
        cc: {
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

    it("throws for a `computed:` page id, naming the address", async () => {
      const processor = {
        getSpaceCtx: homeSpaceCtx,
        runtime: {
          getCellFromEntityId: () => {
            throw new Error("computed page id reached the runtime lookup");
          },
        },
        cc: {
          getSpace: () => "did:key:z6Mk-runtime-processor-slug",
        },
      };

      const computed = `computed:${fid("not-a-page")}`;
      await expect(
        (RuntimeProcessor.prototype as any).handlePageGetSlug.call(processor, {
          type: RequestType.PageGetSlug,
          pageId: computed,
        }),
      ).rejects.toThrow(`Kinded entity id \`${computed}\``);
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

    it("carries either spelling of a pageId to the same entity", async () => {
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
      const lookedUp: string[] = [];
      const processor = {
        getSpaceCtx: () => ({
          getSpace: () => space,
          getPieceCell: (...args: unknown[]) => {
            managerCalls.push(args);
            return Promise.resolve(resultCell);
          },
        }),
        runtime: {
          getCellFromEntityId: (_space: unknown, entityId: unknown) => {
            lookedUp.push(String(entityId));
            return requestedCell;
          },
        },
      };

      for (const pageId of [bare, `of:${bare}`]) {
        await (RuntimeProcessor.prototype as any).handlePageGet.call(
          processor,
          {
            type: RequestType.PageGet,
            pageId,
            runIt: true,
            space,
          },
        );
      }

      expect(lookedUp).toEqual([bare, bare]);
      // The address handed on to the piece manager still names the requested
      // entity, whichever spelling the request carried.
      expect(
        managerCalls.map(([id]) => entityIdFrom(id as string).taggedHashString),
      ).toEqual([bare, bare]);
      expect(managerCalls.map(([, runIt]) => runIt)).toEqual([true, true]);
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
      const pieces = {
        getSpace: () => space,
        getPieceCell: () => {
          throw new Error(
            "output-cell slug redirects should not load as pieces",
          );
        },
      };
      const processor = {
        getSpaceCtx: homeSpaceCtx,
        runtime: {
          getCellFromEntityId: () => slugCell,
          getCellFromLink: () => targetCell,
        },
        cc: pieces,
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
      const patternIdentity = {
        identity: "pattern-identity",
        symbol: "default",
      };
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
      const pieces = {
        getSpace: () => space,
        getPieceCell: () => {
          throw new Error(
            "nested output-cell slug redirects should not load as pieces",
          );
        },
      };
      const processor = {
        getSpaceCtx: homeSpaceCtx,
        runtime: {
          getCellFromEntityId: () => slugCell,
          getCellFromLink: () => targetCell,
        },
        cc: pieces,
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

    it("loads slug redirects to piece cells through the pieces controller", async () => {
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
      const pieces = {
        getSpace: () => space,
        getPieceCell: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(resultCell);
        },
      };
      const processor = {
        getSpaceCtx: homeSpaceCtx,
        runtime: {
          getCellFromEntityId: () => slugCell,
          getCellFromLink: () => pieceCell,
        },
        cc: pieces,
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

  describe("toConsoleDebugValue", () => {
    /** A cell reference as it is rendered, whatever entity it names. */
    const CELL_LINK = /^\[Cell: of:fid1:[^\]]+\]$/;

    /**
     * Makes a runtime and a synced cell holding `{ name, count, self }`, where
     * `self` is the cell itself, along with the teardown the caller runs when
     * done with them.
     */
    async function withCell(): Promise<
      { cell: Cell<Record<string, unknown>>; done: () => Promise<void> }
    > {
      const storageManager = StorageManager.emulate({ as: cfcSigner });
      const runtime = new Runtime({
        apiUrl: new URL("https://toolshed.test"),
        storageManager,
      });
      const cell = runtime.getCell<Record<string, unknown>>(
        cfcSigner.did(),
        "console-debug-value",
      );
      await cell.sync();
      const tx = runtime.edit();
      cell.withTx(tx).set({ name: "test", count: 42, self: cell });
      await tx.commit();

      return {
        cell,
        done: async () => {
          await runtime.dispose();
          await storageManager.close();
        },
      };
    }

    it("carries a long string whole", () => {
      // The renderer's default string length would cut what a pattern logs
      // at two hundred characters; the tail here sits past that.

      const value = `${"x".repeat(299)}END`;
      expect(toConsoleDebugValue(value)).toBe(value);
    });

    describe("what the transport accepts", () => {
      /**
       * Puts `value` through the ends the notification actually uses: the
       * producer's `toConsoleDebugValue()`, the envelope's encode,
       * `postMessage`'s structured clone, and the decode the transport does on
       * arrival. There is one encode, the envelope's.
       */
      function acrossTheWire(value: unknown): unknown {
        return fabricFromRealmValue(
          structuredClone(realmFromFabricValue(toConsoleDebugValue(value))),
        );
      }

      it("returns a value the realm encoding carries, for each shape it renders", () => {
        // The postcondition is that the result is a `FabricValue`, which is
        // what the encoding is defined over -- and that is not expressible as a
        // type either, since the type admits values a walk can still build
        // wrong. Each value here is one raw structured clone refuses outright,
        // or one it accepts only by stripping it to something that misdescribes
        // it.

        const cyclic: Record<string, unknown> = { n: 1 };
        cyclic.self = cyclic;
        const values: unknown[] = [
          Symbol("unique"),
          Symbol.for("interned"),
          { nested: Symbol.for("interned") },
          () => {},
          new FabricBytes(new Uint8Array([1, 2, 3])),
          new FabricEpochNsec(1_000n),
          FabricError.fromNativeError(new Error("boom")),
          cyclic,
          new WeakMap(),
          new Map([["a", 1]]),
        ];

        for (const value of values) {
          const converted = toConsoleDebugValue(value);
          expect(isValidFabricValue(converted)).toBe(true);
          expect(acrossTheWire(value)).toEqual(converted);
        }
      });

      it("returns a `FabricPrimitive` that arrives on the far side still live", () => {
        // The whole point of encoding rather than naming: the receiver hands
        // these to `console.log()`, and a devtools inspector shows more of a
        // live value than of a name for one.

        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        const arrived = acrossTheWire({ payload: bytes }) as Record<
          string,
          unknown
        >;
        expect(arrived.payload).toBeInstanceOf(FabricBytes);
        expect(arrived.payload).toEqual(bytes);
      });

      it("returns a value the realm encoding carries, for a cell and a query result", async () => {
        const { cell, done } = await withCell();
        try {
          for (const value of [cell, cell.get(), { held: cell }]) {
            const converted = toConsoleDebugValue(value);
            expect(isValidFabricValue(converted)).toBe(true);
            expect(acrossTheWire(value)).toEqual(converted);
          }
        } finally {
          await done();
        }
      });
    });

    describe("cells", () => {
      it("returns a cell as the link it names", async () => {
        const { cell, done } = await withCell();
        try {
          expect(toConsoleDebugValue(cell)).toMatch(CELL_LINK);
        } finally {
          await done();
        }
      });

      it("returns a cell held in a record beside the record's other keys", async () => {
        const { cell, done } = await withCell();
        try {
          const result = toConsoleDebugValue({
            self: cell,
            name: "test",
          }) as Record<string, unknown>;
          expect(result.name).toBe("test");
          expect(result.self).toMatch(CELL_LINK);
        } finally {
          await done();
        }
      });

      it("returns a query result as its ref together with its data", async () => {
        // Both halves matter: the ref says what the proxy stands for, and the
        // data is what a reader logged it to see.

        const { cell, done } = await withCell();
        try {
          const result = toConsoleDebugValue(cell.get()) as Record<
            string,
            unknown
          >;
          expect(result.__ref).toMatch(CELL_LINK);
          expect(result.name).toBe("test");
          expect(result.count).toBe(42);
        } finally {
          await done();
        }
      });

      it("returns a query result that holds itself as a cycle", async () => {
        // A query result is a fresh proxy per read, so the rendering has to be
        // stable across the reads for the cycle to be seen as one at all.

        const { cell, done } = await withCell();
        try {
          const result = toConsoleDebugValue(cell.get()) as Record<
            string,
            unknown
          >;
          expect(result.self).toEqual({ "/circle": 0 });
        } finally {
          await done();
        }
      });

      it("returns the failure at the query-result key whose read threw", async () => {
        // The ref and the readable keys all survive one key that does not: a
        // debug dump of a value that is misbehaving is exactly the dump that
        // must still arrive.

        const { cell, done } = await withCell();
        try {
          const hostile = new Proxy(cell.get() as Record<string, unknown>, {
            get(target, key) {
              if (key === "count") throw new Error("read failed");
              return Reflect.get(target, key);
            },
          });
          const result = toConsoleDebugValue(hostile) as Record<
            string,
            unknown
          >;
          expect(result.__ref).toMatch(CELL_LINK);
          expect(result.name).toBe("test");
          expect(result.count).toEqual({ "/unconvertible": "read failed" });
        } finally {
          await done();
        }
      });

      it("returns a query result whose keys cannot be listed the same way at each position", async () => {
        // The rendering a proxy is held under is the finished one, so a proxy
        // that fails before its keys can be read reports that failure wherever
        // it appears rather than a half-built record at its later positions.

        const { cell, done } = await withCell();
        try {
          const keysThrow = new Proxy(cell.get() as Record<string, unknown>, {
            ownKeys() {
              throw new Error("cannot list keys");
            },
            get(target, key) {
              return Reflect.get(target, key);
            },
          });
          const failure = { "/unconvertible": "cannot list keys" };
          expect(toConsoleDebugValue({ a: keysThrow, b: keysThrow }))
            .toEqual({ a: failure, b: failure });
        } finally {
          await done();
        }
      });

      it("returns a query result reached twice at both of its positions", async () => {
        const { cell, done } = await withCell();
        try {
          // Neither position is inside the other, so both are shown in full.
          // The rendering is shared between them, which is what makes a cycle
          // through a query result detectable at all, and this is the sibling
          // case that has to survive that sharing.
          const proxy = cell.get();
          expect(toConsoleDebugValue({ a: proxy, b: { c: proxy } })).toEqual({
            a: {
              __ref: expect.stringMatching(CELL_LINK),
              name: "test",
              count: 42,
              self: { "/circle": 1 },
            },
            b: {
              c: {
                __ref: expect.stringMatching(CELL_LINK),
                name: "test",
                count: 42,
                self: { "/circle": 2 },
              },
            },
          });
        } finally {
          await done();
        }
      });
    });

    describe("special objects", () => {
      // A `FabricValue` is what the realm encoding is defined over, so every
      // one of these is carried rather than rendered. What the conversion has
      // to get right is leaving them alone.

      it("returns a `FabricPrimitive` unchanged", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(toConsoleDebugValue(bytes)).toBe(bytes);
      });

      it("returns a `FabricPrimitive` unchanged, nested in a record", () => {
        const when = new FabricEpochNsec(1_000n);
        expect(toConsoleDebugValue({ when })).toEqual({ when });
        expect((toConsoleDebugValue({ when }) as { when: unknown }).when)
          .toBe(when);
      });

      it("returns a `FabricInstance` as its codec's encoding", () => {
        // The conversion descends an instance rather than carrying it, since
        // its contents are not reachable by property name.

        const result = toConsoleDebugValue(
          FabricError.fromNativeError(new Error("boom")),
        ) as Record<string, Record<string, unknown>>;
        const [tag] = Object.keys(result);
        expect(tag).toMatch(/^\/Error@/);
        expect(result[tag!]!.message).toBe("boom");
      });

      it("returns an interned symbol unchanged", () => {
        expect(toConsoleDebugValue(Symbol.for("tag"))).toBe(Symbol.for("tag"));
        expect(toConsoleDebugValue({ a: Symbol.for("tag") }))
          .toEqual({ a: Symbol.for("tag") });
      });

      it("leaves a forged `FabricPrimitive` for the encode to refuse", () => {
        // An object on a `FabricPrimitive`'s prototype passes every membership
        // check and has no encoding: `isValidFabricValue()` says true and the
        // encode refuses. Producing one takes deliberate effort, so it is not
        // worth a second walk of every console argument to find early; it is
        // left to fail where the encoding is actually done.

        const forged = Object.create(FabricBytes.prototype);
        expect(isValidFabricValue(toConsoleDebugValue(forged))).toBe(true);
        expect(() => realmFromFabricValue(toConsoleDebugValue(forged)))
          .toThrow();
      });

      it("returns a unique symbol as its marker", () => {
        // Unlike an interned one, this has no encoding: the description is all
        // that can be said about it on the far side.

        expect(toConsoleDebugValue(Symbol("x")))
          .toEqual({ "/uniqueSymbol": "x" });
      });
    });

    describe("sharing and cycles", () => {
      it("returns a twice-reachable value at both of its positions", () => {
        // Shared, not circular: neither position is inside the other. Reporting
        // the second as a cycle would misdescribe the data the dump exists to
        // show.

        const shared = { n: 1 };
        expect(toConsoleDebugValue({ x: shared, y: shared }))
          .toEqual({ x: { n: 1 }, y: { n: 1 } });
      });

      it("returns a value shared between siblings after a deep subtree", () => {
        const shared = { n: 1 };
        expect(
          toConsoleDebugValue({ deep: { a: { b: shared } }, later: shared }),
        )
          .toEqual({ deep: { a: { b: { n: 1 } } }, later: { n: 1 } });
      });

      it("returns a value that holds itself as a cycle", () => {
        const cyclic: Record<string, unknown> = { name: "test" };
        cyclic.self = cyclic;
        expect(toConsoleDebugValue(cyclic))
          .toEqual({ name: "test", self: { "/circle": 0 } });
      });

      it("returns an array that holds itself as a cycle", () => {
        const cyclic: unknown[] = [1, 2];
        cyclic.push(cyclic);
        expect(toConsoleDebugValue(cyclic)).toEqual([1, 2, { "/circle": 0 }]);
      });
    });

    describe("primitives", () => {
      it("returns null and undefined unchanged", () => {
        expect(toConsoleDebugValue(null)).toBe(null);
        expect(toConsoleDebugValue(undefined)).toBe(undefined);
      });

      it("returns numbers, strings, and booleans unchanged", () => {
        expect(toConsoleDebugValue(42)).toBe(42);
        expect(toConsoleDebugValue("hello")).toBe("hello");
        expect(toConsoleDebugValue(true)).toBe(true);
      });
    });

    describe("functions", () => {
      it("returns a function named where it has a name", () => {
        expect(toConsoleDebugValue(() => {}))
          .toEqual({ "/function": "<anonymous>(...)" });
        expect(toConsoleDebugValue(function named() {}))
          .toEqual({ "/function": "named(...)" });
      });
    });

    describe("plain objects", () => {
      it("returns a simple object unchanged", () => {
        expect(toConsoleDebugValue({ name: "test", count: 42 }))
          .toEqual({ name: "test", count: 42 });
      });

      it("returns a nested object with its nesting intact", () => {
        expect(toConsoleDebugValue({ outer: { inner: { value: new Map() } } }))
          .toEqual({ outer: { inner: { value: { "/Map": "/..." } } } });
      });

      it("returns a function-valued property rendered in place", () => {
        expect(toConsoleDebugValue({ name: "test", callback: () => {} }))
          .toEqual({
            name: "test",
            callback: { "/function": "callback(...)" },
          });
      });
    });

    describe("arrays", () => {
      it("returns an array of primitives unchanged", () => {
        expect(toConsoleDebugValue([1, 2, 3])).toEqual([1, 2, 3]);
      });

      it("returns an array of objects with each element converted", () => {
        expect(toConsoleDebugValue([{ a: 1 }, { b: new Map() }]))
          .toEqual([{ a: 1 }, { b: { "/Map": "/..." } }]);
      });

      it("returns a function element rendered in place", () => {
        expect(toConsoleDebugValue([1, () => {}, 3]))
          .toEqual([1, { "/function": "<anonymous>(...)" }, 3]);
      });
    });

    describe("depth limit", () => {
      it("returns the elision marker where the nesting runs past the limit", () => {
        const deep = {
          l1: {
            l2: { l3: { l4: { l5: { l6: { l7: { l8: "too deep" } } } } } },
          },
        };
        expect(toConsoleDebugValue(deep)).toEqual({
          l1: { l2: { l3: { l4: { l5: { l6: { "/...": "object" } } } } } },
        });
      });

      it("returns a value nested as deep as a reader of plain data needs", () => {
        // The limit sits above what the old walk reached, because the rendering
        // spends levels of its own on an instance's tag and a query result's
        // ref. Plain data is legible past where it used to stop.

        const deep = { l1: { l2: { l3: { l4: { l5: { l6: "leaf" } } } } } };
        expect(toConsoleDebugValue(deep)).toEqual(deep);
      });
    });

    describe("values that resist being read", () => {
      it("returns the failure at the property whose getter threw", () => {
        const value = {
          safe: "value",
          get dangerous(): never {
            throw new Error("Cannot read this property");
          },
        };
        expect(toConsoleDebugValue(value)).toEqual({
          safe: "value",
          dangerous: { "/unconvertible": "Cannot read this property" },
        });
      });

      it("returns the failure per key for a proxy with a throwing get trap", () => {
        const throwingProxy = new Proxy({}, {
          get() {
            throw new Error("Cannot access property");
          },
          ownKeys() {
            return ["problematic"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true };
          },
        });
        expect(toConsoleDebugValue(throwingProxy))
          .toEqual({
            problematic: { "/unconvertible": "Cannot access property" },
          });
      });

      it("returns the failure for the whole value when its keys cannot be listed", () => {
        const throwingProxy = new Proxy({}, {
          ownKeys() {
            throw new Error("Cannot list keys");
          },
        });
        expect(toConsoleDebugValue(throwingProxy))
          .toEqual({ "/unconvertible": "Cannot list keys" });
      });
    });

    describe("mixed structures", () => {
      it("returns a nested structure with each kind rendered in place", () => {
        const complex = {
          name: "root",
          items: [
            { id: 1, process: () => {} },
            { id: 2, nested: { deep: true } },
          ],
          metadata: { count: 42, handler: function handle() {} },
        };

        expect(toConsoleDebugValue(complex)).toEqual({
          name: "root",
          items: [
            { id: 1, process: { "/function": "process(...)" } },
            { id: 2, nested: { deep: true } },
          ],
          metadata: {
            count: 42,
            handler: { "/function": "handle(...)" },
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

      const response = await RuntimeProcessor.prototype.detectNonIdempotent
        .call(
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

      const response = RuntimeProcessor.prototype.getSettleStats.call(
        processor,
        {
          type: RequestType.GetSettleStats,
        },
      );
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

      // The bytes as the transport's decode delivers them: the handler owns
      // its request's payload. Kept here so the test can check what became of it.
      const payload = new FabricBytes(new Uint8Array([1, 2, 3]));

      try {
        await expect(
          RuntimeProcessor.prototype.handleUploadBlob.call(processor, {
            type: RequestType.UploadBlob,
            space: "did:key:test-space" as never,
            contentType: "image/png",
            body: payload,
            suffix: "png",
          }),
        ).resolves.toEqual({
          id: "fid1:test",
          url: "http://toolshed.test/did:key:test-space/blobs/test.png",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      // The handler no longer decodes, so the ceding that `BaseRequest`'s
      // ownership rule turns on happens at the envelope rather than here: the
      // bytes arrive already decoded and are handed on as they are.

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
    it("routes the home root through ensureDefaultPattern even when the legacy pattern meta is present", async () => {
      // The sharpest pin of the always-controller contract: even with a legacy
      // `pattern` meta present and the update flag unset, the handler reaches
      // ensureDefaultPattern — the leg carrying the cold-start setup repair —
      // and never starts the pattern directly. A metadata shortcut in front of
      // the controller would skip that repair, and with the flag unset (every
      // default deployment) nothing else heals an aged home root.

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
      const defaultPatternCell = {
        ...defaultPatternRef,
        getAsLink: () => cellRefToSigilLink(defaultPatternRef),
        getAsNormalizedFullLink: () => defaultPatternRef,
        getMetaRaw: (metaField: string) =>
          metaField === "pattern" ? cellRefToSigilLink(patternRef) : undefined,
        sync: () => Promise.resolve(),
      };
      let startedDirectly = false;
      const runtime = {
        userIdentityDID: "did:key:test-home",
        experimental: {},
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
    describe("handleGetSpaceRootPattern()", () => {
      it("returns the root ensured by the controller", async () => {
        const ref: CellRef = {
          id: "of:root-result" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          scope: "space",
          path: [],
        };
        const rootCell = { getAsLink: () => cellRefToSigilLink(ref) };
        const cc = {
          ensureDefaultPattern: () =>
            Promise.resolve({ getCell: () => rootCell }),
        };
        const processor = {
          getSpaceCtx: () => cc,
        } as unknown as RuntimeProcessor;

        const result = await RuntimeProcessor.prototype
          .handleGetSpaceRootPattern
          .call(processor, {
            type: RequestType.GetSpaceRootPattern,
            space: "did:key:test-space",
          });
        expect(result.page.cell).toEqual(ref);
      });

      it("resolves the stored root without starting it when start is false", async () => {
        const ref: CellRef = {
          id: "of:stored-root" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          scope: "space",
          path: [],
        };
        const calls: string[] = [];
        const cc = {
          getDefaultPattern: (open: unknown) => {
            calls.push(`getDefaultPattern:${JSON.stringify(open)}`);
            return Promise.resolve({
              getAsLink: () => cellRefToSigilLink(ref),
            });
          },
          ensureDefaultPattern: () => {
            calls.push("ensureDefaultPattern");
            return Promise.reject(new Error("must not run the root"));
          },
        };
        const processor = {
          getSpaceCtx: () => cc,
        } as unknown as RuntimeProcessor;

        const result = await RuntimeProcessor.prototype
          .handleGetSpaceRootPattern
          .call(processor, {
            type: RequestType.GetSpaceRootPattern,
            space: "did:key:test-space",
            start: false,
          });

        expect(result.page.cell).toEqual(ref);
        // Reconciled but not started: a read of what the root exported still
        // heals a stale root, and never boots it.
        expect(calls).toEqual([
          'getDefaultPattern:{"reconcile":true,"start":false}',
        ]);
      });

      it("creates the root for a space that has none, even when start is false", async () => {
        const ref: CellRef = {
          id: "of:created-root" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          scope: "space",
          path: [],
        };
        const calls: string[] = [];
        const cc = {
          // A space whose root has never existed has nothing stored to read.
          getDefaultPattern: () => {
            calls.push("getDefaultPattern");
            return Promise.resolve(undefined);
          },
          ensureDefaultPattern: () => {
            calls.push("ensureDefaultPattern");
            return Promise.resolve({
              getCell: () => ({ getAsLink: () => cellRefToSigilLink(ref) }),
            });
          },
        };
        const processor = {
          getSpaceCtx: () => cc,
        } as unknown as RuntimeProcessor;

        const result = await RuntimeProcessor.prototype
          .handleGetSpaceRootPattern
          .call(processor, {
            type: RequestType.GetSpaceRootPattern,
            space: "did:key:test-space",
            start: false,
          });

        expect(result.page.cell).toEqual(ref);
        expect(calls).toEqual(["getDefaultPattern", "ensureDefaultPattern"]);
      });
    });
  });

  describe("RuntimeProcessor cell pull IPC", () => {
    it("waits for producer commit durability before returning a cell value", async () => {
      const ref: CellRef = {
        id: "of:lazy-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "session",
        path: [],
      };
      const calls: string[] = [];
      let durable = false;
      const processor = Object.assign(
        Object.create(
          RuntimeProcessor.prototype,
        ),
        {
          runtime: {
            getCellFromLink: () => ({
              pull: () => {
                calls.push("pull");
                return Promise.resolve();
              },
              get: () => durable ? { ready: true } : undefined,
            }),
            scheduler: {
              idleWithPendingCommits: () => {
                calls.push("commits");
                durable = true;
                return Promise.resolve();
              },
            },
          },
        },
      ) as RuntimeProcessor;

      await expect(
        processor.handleRequest({
          type: RequestType.CellPull,
          cell: ref,
        }),
      ).resolves.toEqual({ value: { ready: true } });
      expect(calls).toEqual(["pull", "commits"]);
    });
  });

  describe("RuntimeProcessor CFC label IPC", () => {
    /**
     * Mints a cell carrying a label view whose one caveat names a source, the
     * shape the display redaction exists to rewrite. A read hands the response
     * path live cells like this one, and the conversion attaches each cell's
     * carried view to the link it mints for it.
     */
    function cellCarryingSourcedView(
      runtime: Runtime,
      id: string,
    ): Cell<unknown> {
      const link = runtime.getCell(cfcSigner.did(), id).getAsLink();
      setLinkCfcLabelView(link, {
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
      } as CfcLabelView);
      return runtime.getCellFromLink(link);
    }

    /**
     * The one caveat of the view riding `link`, read through the link
     * representation rather than by navigating the envelope by hand.
     */
    function sourcedCaveatOf(link: SigilLink): Record<string, unknown> {
      const view = linkCfcLabelView(link);
      expect(view).toBeDefined();
      return view!.entries[0].label.confidentiality![0] as Record<
        string,
        unknown
      >;
    }

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
            get: () => "labeled data",
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
                  value: "labeled data",
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
                  value: "labeled data",
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

    it("redacts Caveat.source in the label views carried by cells inside handleCellGet values", async () => {
      const storageManager = StorageManager.emulate({ as: cfcSigner });
      const runtime = new Runtime({
        apiUrl: new URL("https://toolshed.test"),
        storageManager,
      });
      try {
        const ref: CellRef = {
          id: "of:cfc-value-view-cell" as CellRef["id"],
          space: "did:key:test" as CellRef["space"],
          scope: "space",
          path: [],
        };
        const carrier = cellCarryingSourcedView(
          runtime,
          "cfc-value-view-linked",
        );
        const processor = {
          runtime: {
            getCellFromLink: () => ({
              get: () => ({ nested: carrier }),
            }),
          },
        } as unknown as RuntimeProcessor;

        const response = RuntimeProcessor.prototype.handleCellGet.call(
          processor,
          {
            type: RequestType.CellGet,
            cell: ref,
          },
        );
        const atom = sourcedCaveatOf(
          (response.value as { nested: SigilLink }).nested,
        );
        expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
        expect(atom.kind).toBe("derived-from");
        expect("source" in atom).toBe(false);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("returns the read cell's schema-bearing ref when includeRef is set", () => {
      const ref: CellRef = {
        id: "of:include-ref-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };
      const processor = {
        runtime: {
          getCellFromLink: () => ({
            get: () => "plain value",
            getAsLink: () => ({
              "/": {
                "link@1": {
                  id: "of:include-ref-cell",
                  space: "did:key:test",
                  path: [],
                  schema: { type: "string" },
                },
              },
            }),
          }),
        },
      } as unknown as RuntimeProcessor;

      const withRef = RuntimeProcessor.prototype.handleCellGet.call(processor, {
        type: RequestType.CellGet,
        cell: ref,
        includeRef: true,
      });
      expect(withRef.cell?.id).toBe("of:include-ref-cell");
      expect(withRef.cell?.schema).toEqual({ type: "string" });

      // Not requested: not returned.
      const without = RuntimeProcessor.prototype.handleCellGet.call(processor, {
        type: RequestType.CellGet,
        cell: ref,
      });
      expect(without.cell).toBeUndefined();
    });

    it("returns the ref alongside the CFC label when both are requested", () => {
      const ref: CellRef = {
        id: "of:include-ref-label-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };
      const processor = {
        runtime: {
          getCellFromLink: () => ({
            get: () => "plain value",
            getAsLink: () => ({
              "/": {
                "link@1": {
                  id: "of:include-ref-label-cell",
                  space: "did:key:test",
                  path: [],
                },
              },
            }),
            runtime: {
              readTx: () => ({
                readOrThrow: () => ({ value: "plain value" }),
              }),
            },
            getAsNormalizedFullLink: () => ref,
            getMetaRaw: () => undefined,
          }),
        },
      } as unknown as RuntimeProcessor;

      const response = RuntimeProcessor.prototype.handleCellGet.call(
        processor,
        {
          type: RequestType.CellGet,
          cell: ref,
          includeRef: true,
          includeCfcLabel: true,
        },
      );
      expect(response.cell?.id).toBe("of:include-ref-label-cell");
      // The cell carries no label; the field is present-but-undefined.
      expect(response.cfcLabel).toBeUndefined();
      expect(response.value).toBe("plain value");
    });

    it("leaves a view on a link the read handed it, which stored data never carries", () => {
      // The response path redacts the views the conversion attaches from live
      // cells and no others: a link already in the read is rebuilt as the
      // container it is. Stored data holds no view on a link, the persist
      // seam having stripped it, so this is the bound of what the redaction
      // covers rather than a leak. A source failing to survive here says the
      // bound moved; one surviving in production says a view reached stored
      // data.

      const ref: CellRef = {
        id: "of:cfc-value-handed-view-cell" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };
      const linkWithView = {
        "/": {
          "link@1": {
            id: "of:cfc-value-handed-view-linked",
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

      const response = RuntimeProcessor.prototype.handleCellGet.call(
        processor,
        {
          type: RequestType.CellGet,
          cell: ref,
        },
      );
      const atom = sourcedCaveatOf(
        (response.value as { nested: SigilLink }).nested,
      );
      expect(atom.source).toBe("did:key:alice");
    });

    it("redacts Caveat.source in the label views carried by cells inside subscription updates", async () => {
      const storageManager = StorageManager.emulate({ as: cfcSigner });
      const runtime = new Runtime({
        apiUrl: new URL("https://toolshed.test"),
        storageManager,
      });
      try {
        const ref: CellRef = {
          id: "of:cfc-subscribe-view-cell" as CellRef["id"],
          space: "did:key:test" as CellRef["space"],
          scope: "space",
          path: [],
          schema: { type: "object", additionalProperties: true },
        };
        const carrier = cellCarryingSourcedView(
          runtime,
          "cfc-subscribe-view-linked",
        );
        const processor = {
          subscriptions: new Map(),
          runtime: {
            getCellFromLink: () => ({
              sink: (
                callback: (value: unknown, cfcLabel: unknown) => void,
              ) => {
                callback({ nested: carrier }, undefined);
                return () => {};
              },
            }),
          },
        } as unknown as RuntimeProcessor;

        const posted: Array<{ value?: unknown }> = [];
        const orig = self.postMessage;
        (self as { postMessage: unknown }).postMessage = (
          m: { value?: unknown },
        ) =>
          posted.push(
            fabricFromRealmValue(m as never) as { value?: unknown },
          );
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
        const atom = sourcedCaveatOf(
          (posted[0].value as { nested: SigilLink }).nested,
        );
        expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
        expect("source" in atom).toBe(false);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
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

      expect(
        RuntimeProcessor.prototype.handleCellResolveAsCell.call(processor, {
          type: RequestType.CellResolveAsCell,
          cell: sourceRef,
        }),
      ).toEqual({
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

    it("describes a resolved SQLite cell as a SQLite capability", () => {
      const sourceRef: CellRef = {
        id: "of:sqlite-source" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };
      const resolvedRef: CellRef = {
        id: "of:sqlite-database" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
        schema: { type: "object", properties: {} },
      };
      const resolvedCell = {
        getAsLink: () => ({ "/": { "link@1": resolvedRef } }),
        getAsNormalizedFullLink: () => resolvedRef,
        getRaw: () => ({
          id: "fid1:sqlite-database",
          tables: { notes: { type: "object" } },
          scope: "space",
        }),
        runtime: {
          readTx: () => ({
            readOrThrow: () => ({ value: { id: "fid1:sqlite-database" } }),
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

      expect(response.cell).toEqual({
        ...resolvedRef,
        schema: {
          type: "object",
          properties: {},
          asCell: ["sqlite"],
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
              value: "labeled data",
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

    const createProcessor = (
      commitResult: { ok?: object; error?: { message: string } } = { ok: {} },
      commitFailure?: Error,
    ) => {
      const calls: Array<{
        cell: unknown;
        value: unknown;
        options: { blind: boolean; supersedeKey?: string };
      }> = [];
      let prepared = false;
      const tx = {
        commit: () => {
          expect(prepared).toBe(true);
          if (commitFailure) return Promise.reject(commitFailure);
          return Promise.resolve(commitResult);
        },
      };
      const cellWithTx = {
        push: (...values: unknown[]) => {
          expect(values).toEqual(["new value"]);
        },
        send: (value: unknown) => {
          expect(value).toBe("new value");
        },
      };
      const resolvedCell = {
        marker: "resolved-cell",
        withTx: (candidateTx: unknown) => {
          expect(candidateTx).toBe(tx);
          return cellWithTx;
        },
      };
      return {
        calls,
        resolvedCell,
        processor: Object.assign(Object.create(RuntimeProcessor.prototype), {
          runtime: {
            edit: () => tx,
            prepareTxForCommit: (candidate: unknown) => {
              expect(candidate).toBe(tx);
              prepared = true;
            },
            getCellFromLink: (candidate: unknown) => {
              expect(candidate).toBe(ref);
              return resolvedCell;
            },
            commitUiCellWrite: (
              cell: unknown,
              value: unknown,
              options: { blind: boolean; supersedeKey?: string },
            ) => {
              calls.push({ cell, value, options });
              if (commitFailure) return Promise.reject(commitFailure);
              return Promise.resolve(commitResult);
            },
          },
        }) as RuntimeProcessor,
      };
    };

    it("routes a cell set through the blind supersede lane", () => {
      const { processor, calls, resolvedCell } = createProcessor();

      RuntimeProcessor.prototype.handleCellSet.call(processor, {
        type: RequestType.CellSet,
        cell: ref,
        value: "new value",
      });

      expect(calls).toEqual([{
        cell: resolvedCell,
        value: "new value",
        options: {
          blind: true,
          supersedeKey: JSON.stringify([
            ref.space,
            ref.id,
            ref.scope,
            ref.path,
          ]),
        },
      }]);
    });

    it("prepares mergeable cell append transactions before committing", async () => {
      const { processor } = createProcessor();

      await RuntimeProcessor.prototype.handleCellPush.call(processor, {
        type: RequestType.CellPush,
        cell: ref,
        values: ["new value"],
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

    it("observes rejected fire-and-forget cell commits", async () => {
      const calls: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => calls.push(args);
      try {
        const set = createProcessor(
          { ok: {} },
          new Error("set commit rejected"),
        );
        const push = createProcessor(
          { ok: {} },
          new Error("push commit rejected"),
        );
        const send = createProcessor(
          { ok: {} },
          new Error("send commit rejected"),
        );

        RuntimeProcessor.prototype.handleCellSet.call(set.processor, {
          type: RequestType.CellSet,
          cell: ref,
          value: "new value",
        });
        RuntimeProcessor.prototype.handleCellPush.call(push.processor, {
          type: RequestType.CellPush,
          cell: ref,
          values: ["new value"],
        });
        RuntimeProcessor.prototype.handleCellSend.call(send.processor, {
          type: RequestType.CellSend,
          cell: ref,
          event: "new value",
        });
        await Promise.resolve();

        expect(calls.map(([message]) => message)).toEqual([
          "[RuntimeProcessor] Cell set commit failed:",
          "[RuntimeProcessor] Cell push commit failed:",
          "[RuntimeProcessor] Cell send commit failed:",
        ]);
      } finally {
        console.error = original;
      }
    });

    it("observes resolved fire-and-forget cell commit refusals", async () => {
      const calls: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => calls.push(args);
      try {
        const set = createProcessor({ error: { message: "set refused" } });
        const push = createProcessor({ error: { message: "push refused" } });
        const send = createProcessor({ error: { message: "send refused" } });

        RuntimeProcessor.prototype.handleCellSet.call(set.processor, {
          type: RequestType.CellSet,
          cell: ref,
          value: "new value",
        });
        RuntimeProcessor.prototype.handleCellPush.call(push.processor, {
          type: RequestType.CellPush,
          cell: ref,
          values: ["new value"],
        });
        RuntimeProcessor.prototype.handleCellSend.call(send.processor, {
          type: RequestType.CellSend,
          cell: ref,
          event: "new value",
        });
        await Promise.resolve();

        expect(calls.map(([message]) => message)).toEqual([
          "[RuntimeProcessor] Cell push commit failed:",
          "[RuntimeProcessor] Cell send commit failed:",
        ]);
      } finally {
        console.error = original;
      }
    });

    it("returns a strict set commit refusal to the caller", async () => {
      const { processor } = createProcessor({
        error: { message: "set refused" },
      });

      await expect(RuntimeProcessor.prototype.handleCellSet.call(processor, {
        type: RequestType.CellSet,
        cell: ref,
        value: "new value",
        awaitCommit: true,
      })).rejects.toThrow("set refused");
    });

    it("returns a confirmed append commit refusal to the caller", async () => {
      const { processor } = createProcessor({
        error: { message: "push refused" },
      });

      await expect(
        RuntimeProcessor.prototype.handleCellPush.call(processor, {
          type: RequestType.CellPush,
          cell: ref,
          values: ["new value"],
          awaitCommit: true,
        }),
      ).rejects.toThrow("push refused");
    });

    it("returns a strict send commit refusal to the caller", async () => {
      const { processor } = createProcessor({
        error: { message: "send refused" },
      });

      await expect(RuntimeProcessor.prototype.handleCellSend.call(processor, {
        type: RequestType.CellSend,
        cell: ref,
        event: "new value",
        awaitCommit: true,
      })).rejects.toThrow("send refused");
    });
  });

  describe("direct cell appends", () => {
    it("keeps object members distinct across independent callers", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-cell-push-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const schema = {
          type: "array",
          items: {
            type: "object",
            properties: {
              optionId: { type: "string" },
            },
            required: ["optionId"],
          },
          default: [],
        } as const;
        const cell = runtime.getCell<Array<{ optionId: string }>>(
          space,
          `direct-cell-push-${crypto.randomUUID()}`,
          schema,
        );
        await cell.sync();
        const seed = runtime.edit();
        cell.withTx(seed).set([]);
        expect((await seed.commit()).error).toBeUndefined();

        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        const append = async (value: { optionId: string }) => {
          const callerFrame = pushFrame({
            runtime,
            generatedIdCounter: 0,
          });
          try {
            await processor.handleCellPush({
              type: RequestType.CellPush,
              cell: createCellRef(cell),
              values: [value],
              awaitCommit: true,
            });
          } finally {
            popFrame(callerFrame);
          }
        };

        await append({ optionId: "library" });
        await append({ optionId: "studio" });
        await cell.pull();

        expect(cell.get()).toEqual([
          { optionId: "library" },
          { optionId: "studio" },
        ]);
        const first = cell.key(0).resolveAsCell().getAsNormalizedFullLink();
        const second = cell.key(1).resolveAsCell().getAsNormalizedFullLink();
        expect(first.id).not.toBe(second.id);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("direct cell initialization", () => {
    it("rejects malformed initializers and surfaces transaction failures", async () => {
      const failed = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          runtime: {
            editWithRetry: () =>
              Promise.resolve({ error: new Error("initialize failed") }),
          },
        },
      ) as RuntimeProcessor;
      const ref = {
        space: "did:key:test" as CellRef["space"],
        id: "of:initialize-failure" as CellRef["id"],
        scope: "space",
        path: [],
      } satisfies CellRef;

      await expect(failed.handleCellInitialize({
        type: RequestType.CellInitialize,
        cell: ref,
        value: undefined as never,
      })).rejects.toThrow("Cell initialize requires a defined value");
      await expect(failed.handleCellInitialize({
        type: RequestType.CellInitialize,
        cell: ref,
        value: 1,
      })).rejects.toThrow("initialize failed");
    });

    it("loads an existing scoped value before choosing an initializer", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-scoped-cell-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const server = new MemoryV2Server.Server({
        authorizeSessionOpen(message) {
          const principal = (message.authorization as { principal?: unknown })
            ?.principal;
          return typeof principal === "string" ? principal : undefined;
        },
        sessionOpenAuth: { audience: testSessionOpenAudience },
      });
      const managerOptions = {
        as: signer,
        memoryHost: new URL("memory://"),
      };
      const writerStorage = new SharedV2StorageManager(managerOptions, server);
      const readerStorage = new SharedV2StorageManager(managerOptions, server);
      const writerRuntime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager: writerStorage,
      });
      const readerRuntime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager: readerStorage,
      });
      try {
        const cause = `direct-scoped-cell-initialize-${crypto.randomUUID()}`;
        const schema = {
          type: "object",
          properties: { winner: { type: "string" } },
          required: ["winner"],
        } as const;
        const writerCell = writerRuntime.getCell<{ winner: string }>(
          space,
          cause,
          schema,
          undefined,
          "user",
        );
        await writerCell.sync();
        const write = writerRuntime.edit();
        writerCell.withTx(write).set({ winner: "stored" });
        expect((await write.commit()).error).toBeUndefined();

        const readerCell = readerRuntime.getCell<{ winner: string }>(
          space,
          cause,
          schema,
          undefined,
          "user",
        );
        expect(readerCell.get()).toBeUndefined();
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime: readerRuntime },
        ) as RuntimeProcessor;

        const selected = await processor.handleCellInitialize({
          type: RequestType.CellInitialize,
          cell: createCellRef(readerCell),
          value: { winner: "default" },
        });
        await readerCell.pull();

        expect(selected.value).toEqual({ winner: "stored" });
        expect(readerCell.get()).toEqual({ winner: "stored" });
      } finally {
        await writerRuntime.dispose();
        await readerRuntime.dispose();
        await writerStorage.close();
        await readerStorage.close();
      }
    });

    it("converges concurrent initializers on one stored value", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-cell-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const cell = runtime.getCell<{ winner: string }>(
          space,
          `direct-cell-initialize-${crypto.randomUUID()}`,
          {
            type: "object",
            properties: { winner: { type: "string" } },
            required: ["winner"],
          },
        );
        await cell.sync();
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        const ref = createCellRef(cell);

        const [first, second] = await Promise.all([
          processor.handleCellInitialize({
            type: RequestType.CellInitialize,
            cell: ref,
            value: { winner: "first" },
          }),
          processor.handleCellInitialize({
            type: RequestType.CellInitialize,
            cell: ref,
            value: { winner: "second" },
          }),
        ]);
        await cell.pull();

        expect(first.value).toEqual(second.value);
        expect([{ winner: "first" }, { winner: "second" }]).toContainEqual(
          first.value,
        );
        expect(cell.get()).toEqual(first.value);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("materializes a schema default before a nested append", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-default-cell-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const initial = {
          bars: [
            { id: "alpha", value: 3 },
            { id: "beta", value: 5 },
          ],
        };
        const schema = {
          type: "object",
          properties: {
            bars: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: "number" },
                },
                required: ["id", "value"],
              },
            },
          },
          required: ["bars"],
          default: initial,
        } as const;
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        for (const scope of ["user", "session"] as const) {
          const cell = runtime.getCell<typeof initial>(
            space,
            `direct-default-cell-initialize-${scope}-${crypto.randomUUID()}`,
            schema,
            undefined,
            scope,
          );
          await cell.sync();
          expect(cell.get()).toEqual(initial);
          expect(cell.asSchema(undefined).getRaw()).toBeUndefined();

          await expect(processor.handleCellInitialize({
            type: RequestType.CellInitialize,
            cell: createCellRef(cell),
            value: initial,
          })).resolves.toEqual({ value: initial });
          expect(cell.asSchema(undefined).getRaw()).not.toBeUndefined();

          const append = runtime.edit();
          cell.withTx(append).key("bars").push({ id: "gamma", value: 7 });
          expect((await append.commit()).error).toBeUndefined();
          expect(cell.get()).toEqual({
            bars: [...initial.bars, { id: "gamma", value: 7 }],
          });
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("materializes a write-redirect target before a nested append", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-linked-default-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const initial = {
          bars: [
            { id: "alpha", value: 3 },
            { id: "beta", value: 5 },
          ],
        };
        const schema = {
          type: "object",
          properties: {
            bars: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: "number" },
                },
                required: ["id", "value"],
              },
            },
          },
          required: ["bars"],
          default: initial,
        } as const;
        const target = runtime.getCell<typeof initial>(
          space,
          `direct-linked-default-target-${crypto.randomUUID()}`,
          schema,
        );
        const alias = runtime.getCell<typeof initial>(
          space,
          `direct-linked-default-alias-${crypto.randomUUID()}`,
          schema,
        );
        await Promise.all([target.sync(), alias.sync()]);
        const link = runtime.edit();
        alias.withTx(link).setRawUntyped(
          target.getAsWriteRedirectLink({ includeSchema: false }),
        );
        expect((await link.commit()).error).toBeUndefined();
        expect(alias.get()).toEqual(initial);
        expect(target.asSchema(undefined).getRaw()).toBeUndefined();

        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        await expect(processor.handleCellInitialize({
          type: RequestType.CellInitialize,
          cell: createCellRef(alias),
          value: initial,
        })).resolves.toEqual({ value: initial });
        expect(target.asSchema(undefined).getRaw()).not.toBeUndefined();

        const append = runtime.edit();
        alias.withTx(append).key("bars").push({ id: "gamma", value: 7 });
        expect((await append.commit()).error).toBeUndefined();
        expect(alias.get()).toEqual({
          bars: [...initial.bars, { id: "gamma", value: 7 }],
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("does not initialize through a scope-capped write redirect", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-capped-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const schema = {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
          default: { n: 1 },
          scope: "space",
        } as const;
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;

        for (const existing of [undefined, { n: 7 }] as const) {
          const target = runtime.getCell<{ n: number }>(
            space,
            `direct-capped-target-${crypto.randomUUID()}`,
            undefined,
            undefined,
            "session",
          );
          const alias = runtime.getCell<{ n: number }>(
            space,
            `direct-capped-alias-${crypto.randomUUID()}`,
          );
          await Promise.all([target.sync(), alias.sync()]);
          const seed = runtime.edit();
          if (existing !== undefined) target.withTx(seed).set(existing);
          alias.withTx(seed).setRawUntyped(
            target.getAsWriteRedirectLink({ includeSchema: false }),
          );
          expect((await seed.commit()).error).toBeUndefined();

          const capped = alias.asSchema<{ n: number }>(schema);
          await expect(processor.handleCellInitialize({
            type: RequestType.CellInitialize,
            cell: createCellRef(capped),
            value: { n: 1 },
          })).rejects.toThrow("Cannot write to read-only address");
          expect(target.asSchema(undefined).getRaw()).toEqual(existing);
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects backing values incompatible with the requested schema", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-incompatible-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const cause = `direct-incompatible-initialize-${crypto.randomUUID()}`;
        const raw = runtime.getCell<number>(space, cause);
        await raw.sync();
        const seed = runtime.edit();
        raw.withTx(seed).set(42);
        expect((await seed.commit()).error).toBeUndefined();

        const projected = raw.asSchema<{ n: number }>({
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
          default: { n: 1 },
        });
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;

        await expect(processor.handleCellInitialize({
          type: RequestType.CellInitialize,
          cell: createCellRef(projected),
          value: { n: 1 },
        })).rejects.toThrow("incompatible with its schema");
        expect(raw.get()).toBe(42);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("returns nested initialized cells in the client-hydratable link form", async () => {
      const signer = await Identity.fromPassphrase(
        `direct-linked-cell-initialize-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      });
      try {
        const target = runtime.getCell<{ linked: Cell<unknown> }>(
          space,
          `direct-linked-cell-initialize-${crypto.randomUUID()}`,
        );
        const linked = runtime.getCell(
          space,
          `direct-linked-initializer-${crypto.randomUUID()}`,
        );
        await target.sync();
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        const linkedRef = createCellRef(linked);

        const selected = await processor.handleRequest({
          type: RequestType.CellInitialize,
          cell: createCellRef(target),
          value: { linked: linkedRef },
        }) as { value: unknown };

        expect(selected.value).toEqual({
          linked: cellRefToSigilLink(linkedRef),
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("runtime-client CellRef conversion", () => {
    it("does not forward an inbound label view into worker sigil links", () => {
      // Inv-12 Stage 0 (SC-25 prerequisite): a cfcLabelView riding an inbound
      // CellRef is a main-thread display artifact — round-tripped through
      // CellHandle.deserialize and back — and must not re-enter the worker as
      // label state. Forwarding it onto the written sigil link previously fed
      // recordLinkWritePolicyInput, whose entries prepareBoundaryCommit
      // persisted as link-origin labels; the worker now re-derives those from
      // its own stored source metadata instead.

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

    it("strips label views from raw sigil links in inbound values", () => {
      // Raw sigil links inside inbound values (hand-crafted JSON, or a
      // CellHandle serialized into CustomEvent.detail via toJSON) bypass the
      // CellRef path — the value walker must drop their label views too
      // (codex/cubic review on the Stage 0 PR).

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

    it("hands back a `FabricPrimitive` whole, nested or not", () => {
      // A fabric class keeps its state in private fields and has no enumerable
      // own properties, so the record branch would rebuild one as `{}`. A
      // primitive is atomic and holds no link, so passing it through is the
      // whole answer.

      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      expect(mapCellRefsToSigilLinks(bytes)).toBe(bytes);
      expect(mapCellRefsToSigilLinks({ b: bytes })).toEqual({ b: bytes });
      expect(mapCellRefsToSigilLinks([bytes])).toEqual([bytes]);
      // Identity through a container too: the walk rebuilds the container, and
      // what it puts back has to be the value rather than a copy of it.
      expect(
        (mapCellRefsToSigilLinks({ b: bytes }) as { b: unknown }).b,
      ).toBe(bytes);
    });

    it("refuses a `FabricInstance`, naming the class and the situation", () => {
      // A tripwire, not a limitation to route around: an instance's codec
      // contents can hold a link that this walk cannot reach, so refusing beats
      // the `{}` the record branch would otherwise produce.

      const error = FabricError.fromNativeError(new Error("boom"));
      const message =
        "Cannot yet handle `FabricError` (a `FabricInstance`) when mapping " +
        "cell refs to sigil links.";

      expect(() => mapCellRefsToSigilLinks(error)).toThrow(message);
      // Nested too, the walk reaching it through the container rebuild.
      expect(() => mapCellRefsToSigilLinks({ e: error })).toThrow(message);
      expect(() => mapCellRefsToSigilLinks([error])).toThrow(message);
    });

    it("throws for a value that contains itself, naming the path where the cycle closes", () => {
      const inner: Record<string, unknown> = { leaf: 1 };
      const value = { list: [inner] };
      inner.back = value;

      expect(() => mapCellRefsToSigilLinks(value as unknown as FabricValue))
        .toThrow(
          "Cannot map cell refs to sigil links in a value with a cycle; " +
            "the cycle closes at path `list.0.back`.",
        );
    });

    it("maps a subtree reachable from two positions at each, rather than taking it for a cycle", () => {
      const ref: CellRef = {
        id: "of:shared-subtree" as CellRef["id"],
        space: "did:key:test" as CellRef["space"],
        scope: "space",
        path: [],
      };
      const shared = { ref };

      const mapped = mapCellRefsToSigilLinks({ a: shared, b: shared }) as {
        a: { ref: unknown };
        b: { ref: unknown };
      };

      expect(mapped.a.ref).toEqual(cellRefToSigilLink(ref));
      expect(mapped.b.ref).toEqual(cellRefToSigilLink(ref));
    });
  });

  describe("RuntimeProcessor.getLoggerCounts", () => {
    // The handler reads process-global logger state, so each case raises its own
    // flag and clears it again rather than leaving one for the next.

    function withFlag(
      metadata: Record<string, unknown>,
      body: () => void,
    ): void {
      const logger = getLogger("getLoggerCounts-test");
      logger.flag("probe", "id:1", true, metadata);
      try {
        body();
      } finally {
        logger.resetFlags();
      }
    }

    it("carries a raised flag's metadata through to the response", () => {
      // No `this` is read, so the handler runs against a bare receiver.

      const processor = {} as unknown as RuntimeProcessor;

      withFlag({ a: 1 }, () => {
        const response = RuntimeProcessor.prototype.getLoggerCounts.call(
          processor,
          { type: RequestType.GetLoggerCounts },
        );

        expect(Object.keys(response).sort()).toEqual([
          "counts",
          "flags",
          "metadata",
          "timing",
        ]);
        expect(response.flags["getLoggerCounts-test"].probe["id:1"]).toEqual({
          a: 1,
        });
      });
    });

    it("refuses to answer at all when a flag holds unsendable metadata", () => {
      // The assertion is wired into the handler, not merely available beside it:
      // a `Date` raised anywhere in the process stops this read.

      const processor = {} as unknown as RuntimeProcessor;

      withFlag({ when: new Date(0) }, () => {
        expect(() =>
          RuntimeProcessor.prototype.getLoggerCounts.call(
            processor,
            { type: RequestType.GetLoggerCounts },
          )
        ).toThrow(/not being a `FabricValue`/);
      });
    });
  });

  describe("assertFabricLoggerFlags", () => {
    it("accepts metadata that vets, and a flag raised without any", () => {
      // A `Logger` takes `Record<string, unknown>` and constrains it no further,
      // so what it holds is established here or not at all.

      const flags = {
        runner: {
          "action invalid input": {
            "action:ok": { a: 1, b: ["x", null] },
            "action:bare": null,
          },
        },
      };

      expect(() => assertFabricLoggerFlags(flags)).not.toThrow();
    });

    it("refuses a flag named with a key no `FabricPlainObject` carries", () => {
      // `__proto__` and `constructor` are refused as fabric keys deliberately,
      // and `1-fabric-values.md` specifies it. An IPC payload is a `FabricValue`
      // per se -- the envelope as much as the metadata, a record of
      // `FabricValue`s being one itself -- so a flag named one of them cannot
      // cross, and saying so is the point rather than a limitation to route
      // around.

      const flags = { runner: { constructor: { "id:1": { a: 1 } } } };

      expect(() => assertFabricLoggerFlags(flags)).toThrow(
        /not being a `FabricValue`/,
      );
    });

    it("throws, rendering what it refused", () => {
      // A `Date` clones perfectly well and is not a `FabricValue`, so it is the
      // shape that would otherwise cross as something the far side cannot read.

      const flags = {
        runner: {
          "action invalid input": { "action:bad": { when: new Date(0) } },
        },
      };

      // The rendering is what says which flag is at fault. Asserted through the
      // flag's own id rather than the whole string, so a change to how a `Date`
      // renders does not read as this breaking.
      expect(() => assertFabricLoggerFlags(flags)).toThrow(
        /Cannot send logger flags on this connection, not being a `FabricValue`/,
      );
      expect(() => assertFabricLoggerFlags(flags)).toThrow(/action:bad/);
    });

    it("throws rather than dropping the metadata and reporting the flag", () => {
      // The disposition itself, asserted: dropping the metadata would leave the
      // payload reporting a flag whose contents had silently gone, which is the
      // loss "Death before confusion!" rules out.

      const flags = {
        runner: { sample: { "id:1": { fn: () => 0 } } },
      };

      expect(() => assertFabricLoggerFlags(flags)).toThrow();
      expect(flags.runner.sample["id:1"]).not.toBe(null);
    });
  });

  describe("RuntimeProcessor VDom event label-view ingress", () => {
    it("strips label views from sigil links in inbound VDOM events", () => {
      // CustomEvent.detail is JSON.stringify'd on the main thread (invoking
      // CellHandle.toJSON) and re-enters the worker here, bypassing
      // getCell/cellRefToSigilLink — a handler writing event.detail.sourceCell
      // would persist the ref's view through the sigil-link write path. The
      // worker strips inbound views at this ingress too (codex/cubic review).

      const dispatched: unknown[] = [];
      const processor = {
        vdomMounts: new Map([[
          "0 mount-1",
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

  describe("RuntimeProcessor event attention IPC", () => {
    const space = "did:key:z6Mk-runtime-processor-attention" as never;
    const sidecarId = "of:stream-events:runtime-processor-attention";
    const attention = {
      phase: "dispatch-load" as const,
      failureClass: "session-revoked" as const,
      code: "permanent-delivery-failure" as const,
      firstFailureAt: 10,
      lastFailureAt: 10,
      accumulatedFailureMs: 0,
      failureCount: 1,
      recovery: "explicit-retry" as const,
    };

    it("forwards only complete terminal-attention outcomes", () => {
      let subscriber: ((outcome: never) => void) | undefined;
      const cancel = () => {};
      const posted: unknown[] = [];
      const returned = subscribeEventAttentionNotifications({
        subscribeEventIntentOutcomes(callback: (outcome: never) => void) {
          subscriber = callback as (outcome: never) => void;
          return cancel;
        },
      } as never, (notification) => posted.push(notification));

      expect(returned).toBe(cancel);
      subscriber!({
        kind: "dropped",
        space,
        eventId: "evt-dropped",
        reason: "dropped",
      } as never);
      subscriber!({
        kind: "needs-attention",
        space,
        eventId: "evt-incomplete",
        reason: "incomplete",
      } as never);
      subscriber!({
        kind: "needs-attention",
        space,
        eventId: "evt-complete",
        seq: 40,
        sidecarId,
        retryable: false,
        reason: "complete",
        attention,
      } as never);

      expect(posted).toEqual([{
        type: NotificationType.EventNeedsAttention,
        space,
        eventId: "evt-complete",
        seq: 40,
        sidecarId,
        retryable: false,
        reason: "complete",
        attention,
      }]);
    });

    it("installs and cancels the runtime notification subscription", async () => {
      const server = new MemoryV2Server.Server({
        authorizeSessionOpen: () => cfcSigner.did(),
        sessionOpenAuth: { audience: testSessionOpenAudience },
      });
      const storageManager = new SharedV2StorageManager({
        as: cfcSigner,
        memoryHost: new URL("memory://"),
      }, server);
      const originalOpen = WorkerStorageManager.open;
      const originalHealthCheck = Runtime.prototype.healthCheck;
      const originalWatchSiteTable = RuntimeProcessor.prototype.watchSiteTable;
      const originalSubscribe = Runtime.prototype.subscribeEventIntentOutcomes;
      let subscribed = false;
      let cancelled = 0;
      WorkerStorageManager.open = () => storageManager;
      Runtime.prototype.healthCheck = () => Promise.resolve(true);
      RuntimeProcessor.prototype.watchSiteTable = () => {};
      Runtime.prototype.subscribeEventIntentOutcomes = () => {
        subscribed = true;
        return () => cancelled++;
      };
      try {
        const processor = await RuntimeProcessor.initialize({
          apiUrl: "http://worker.test/",
          identity: cfcSigner.keyPair,
          spaceDid: space,
        });
        expect(subscribed).toBe(true);
        await processor.dispose();
        expect(cancelled).toBe(1);
      } finally {
        WorkerStorageManager.open = originalOpen;
        Runtime.prototype.healthCheck = originalHealthCheck;
        RuntimeProcessor.prototype.watchSiteTable = originalWatchSiteTable;
        Runtime.prototype.subscribeEventIntentOutcomes = originalSubscribe;
        await storageManager.close();
        await server.close();
      }
    });

    it("lists only authoritative unresolved notices and dispatches resolution", async () => {
      const summaries = {
        [eventAttentionEntryKey("evt-valid", 41)]: {
          eventId: "evt-valid",
          seq: 41,
          sidecarId,
          phase: attention.phase,
          failureClass: attention.failureClass,
          code: attention.code,
          firstFailureAt: attention.firstFailureAt,
        },
        [eventAttentionEntryKey("evt-resolved", 42)]: {
          eventId: "evt-resolved",
          seq: 42,
          sidecarId,
          phase: attention.phase,
          failureClass: attention.failureClass,
          code: attention.code,
          firstFailureAt: attention.firstFailureAt,
        },
        [eventAttentionEntryKey("evt-legacy", 0)]: {
          eventId: "evt-legacy",
          seq: 0,
          sidecarId,
          phase: attention.phase,
          failureClass: attention.failureClass,
          code: attention.code,
          firstFailureAt: attention.firstFailureAt,
        },
        [eventAttentionEntryKey("evt-userless", 43)]: {
          eventId: "evt-userless",
          seq: 43,
          sidecarId,
          phase: attention.phase,
          failureClass: attention.failureClass,
          code: attention.code,
          firstFailureAt: attention.firstFailureAt,
        },
      };
      const provider = {
        sync: () => Promise.resolve({}),
        replica: {
          getDocument(id: string) {
            if (id === SERVER_EXECUTION_ATTENTION_DOC_ID) {
              return {
                value: {
                  entries: {
                    [eventAttentionIndexKey(sidecarId)]: summaries,
                  },
                },
              };
            }
            return {
              value: {
                entries: [{
                  eventId: "evt-valid",
                  seq: 41,
                  status: "needs-attention",
                  reason: "safe reason",
                  attention,
                  firedAt: { user: cfcSigner.did() },
                }, {
                  eventId: "evt-resolved",
                  seq: 42,
                  status: "needs-attention",
                  attention,
                  resolution: { kind: "dismissed" },
                  firedAt: { user: cfcSigner.did() },
                }, {
                  eventId: "evt-legacy",
                  status: "needs-attention",
                  reason: "legacy reason",
                  attention,
                  firedAt: { user: cfcSigner.did() },
                }, {
                  eventId: "evt-userless",
                  seq: 43,
                  status: "needs-attention",
                  reason: "system event reason",
                  attention,
                  firedAt: { session: "server" },
                }],
              },
            };
          },
        },
      };
      const resolveCalls: unknown[] = [];
      const processor = {
        runtime: {
          storageManager: {
            open: () => provider,
            resolveEventAttention(
              requestSpace: unknown,
              eventId: unknown,
              seq: unknown,
              requestSidecarId: unknown,
              action: unknown,
            ) {
              resolveCalls.push([
                requestSpace,
                eventId,
                seq,
                requestSidecarId,
                action,
              ]);
              return Promise.resolve({ resolution: { kind: "dismissed" } });
            },
          },
        },
        identity: cfcSigner,
        handleListEventAttention:
          RuntimeProcessor.prototype.handleListEventAttention,
        handleResolveEventAttention:
          RuntimeProcessor.prototype.handleResolveEventAttention,
      } as unknown as RuntimeProcessor;

      expect(
        await RuntimeProcessor.prototype.handleRequest.call(processor, {
          type: RequestType.ListEventAttention,
          space,
        }),
      ).toEqual({
        notices: [{
          space,
          eventId: "evt-valid",
          seq: 41,
          sidecarId,
          retryable: true,
          reason: "safe reason",
          attention,
        }, {
          space,
          eventId: "evt-legacy",
          seq: 0,
          sidecarId,
          retryable: true,
          reason: "legacy reason",
          attention,
        }, {
          space,
          eventId: "evt-userless",
          seq: 43,
          sidecarId,
          retryable: false,
          reason: "system event reason",
          attention,
        }],
      });
      expect(
        await RuntimeProcessor.prototype.handleRequest.call(processor, {
          type: RequestType.ResolveEventAttention,
          space,
          eventId: "evt-valid",
          seq: 41,
          sidecarId,
          action: "dismiss",
        }),
      ).toEqual({ resolution: { kind: "dismissed" } });
      expect(resolveCalls).toEqual([[
        space,
        "evt-valid",
        41,
        sidecarId,
        "dismiss",
      ]]);
    });

    it("surfaces attention index and sidecar synchronization failures", async () => {
      const indexError = new Error("index failed");
      const sidecarError = new Error("sidecar failed");
      const summary = {
        eventId: "evt-failed",
        seq: 43,
        sidecarId,
        phase: attention.phase,
        failureClass: attention.failureClass,
        code: attention.code,
        firstFailureAt: attention.firstFailureAt,
      };
      const invoke = (provider: unknown) =>
        RuntimeProcessor.prototype.handleListEventAttention.call({
          runtime: { storageManager: { open: () => provider } },
          identity: cfcSigner,
        } as never, { type: RequestType.ListEventAttention, space });

      await expect(invoke({
        sync: () => Promise.resolve({ error: indexError }),
      })).rejects.toBe(indexError);
      await expect(invoke({
        sync: () => Promise.resolve({}),
      })).rejects.toThrow("does not expose an attention replica");
      let syncCount = 0;
      await expect(invoke({
        sync: () =>
          Promise.resolve(
            ++syncCount === 1 ? {} : { error: sidecarError },
          ),
        replica: {
          getDocument: () => ({
            value: {
              entries: {
                [eventAttentionIndexKey(sidecarId)]: {
                  [eventAttentionEntryKey(summary.eventId, summary.seq)]:
                    summary,
                },
              },
            },
          }),
        },
      })).rejects.toBe(sidecarError);
    });

    it("rejects resolution when the storage capability is absent", async () => {
      await expect(
        RuntimeProcessor.prototype.handleResolveEventAttention.call({
          runtime: { storageManager: {} },
        } as never, {
          type: RequestType.ResolveEventAttention,
          space,
          eventId: "evt-unsupported",
          seq: 44,
          sidecarId,
          action: "retry",
        }),
      ).rejects.toThrow("does not support event attention");
    });
  });

  describe("worker/host server-execution posture agreement (review 2026-08-11 m7)", () => {
    it("threads the host's declared serverExecution flag through the params mapper verbatim", () => {
      const params = browserWorkerParamsFromInitializationData(
        {
          apiUrl: "http://worker.test/",
          identity: {} as never,
          spaceDid: "did:key:space",
          experimental: { serverExecution: true },
        },
        { as: { did: () => "did:key:worker" } } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[1],
        { marker() {} } as unknown as Parameters<
          typeof browserWorkerParamsFromInitializationData
        >[2],
      );
      expect(params.experimental).toEqual({ serverExecution: true });
    });

    it("agrees silently when postures match — both declared-ON and the undeclared-OFF default (OFF-arm-neutral)", () => {
      assertServerExecutionPostureAgreement(
        { serverExecution: true },
        { experimental: { serverExecution: true } },
      );
      assertServerExecutionPostureAgreement(
        undefined,
        { experimental: { serverExecution: false } },
      );
      assertServerExecutionPostureAgreement(
        {},
        { experimental: {} },
      );
    });

    it("refuses LOUDLY when the host declared ON but the worker resolved OFF (the silent F10 revert, now surfaced)", () => {
      expect(() =>
        assertServerExecutionPostureAgreement(
          { serverExecution: true },
          { experimental: { serverExecution: false } },
        )
      ).toThrow(/posture mismatch/);
      expect(() =>
        assertServerExecutionPostureAgreement(
          { serverExecution: true },
          { experimental: {} },
        )
      ).toThrow(/posture mismatch/);
    });

    it("refuses the mirrored divergence: a worker resolving ON under a host that declared nothing", () => {
      expect(() =>
        assertServerExecutionPostureAgreement(
          undefined,
          { experimental: { serverExecution: true } },
        )
      ).toThrow(/posture mismatch/);
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
      expect(options.patternEnvironment?.apiUrl.href).toBe(
        "http://worker.test/",
      );
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

  describe("RuntimeProcessor per-space piece contexts", () => {
    // Federation PR2: one worker serves page operations for many spaces.
    // getSpaceCtx resolves the per-space PiecesController, lazily for
    // foreign spaces, over the shared runtime/storage.

    const getSpaceCtx = (RuntimeProcessor.prototype as any).getSpaceCtx;

    function makeProcessorState() {
      const { runtime } = createRuntime();
      const homeSpace = cfcSigner.did();
      const cc = new PiecesController(
        { as: cfcSigner, space: homeSpace },
        runtime,
      );
      const processor = {
        runtime,
        identity: cfcSigner,
        space: homeSpace,
        spaces: new Map([[homeSpace, cc]]),
        cc,
        getSpaceCtx,
      };
      return { processor, runtime, homeSpace };
    }

    it("resolves the home space to the initialize-time context and rejects a missing space", async () => {
      const { processor, runtime, homeSpace } = makeProcessorState();
      try {
        expect(processor.getSpaceCtx(homeSpace)).toBe(
          processor.spaces.get(homeSpace),
        );
        expect(processor.getSpaceCtx(homeSpace)).toBe(processor.cc);
        expect(() =>
          (processor as { getSpaceCtx: (s?: string) => unknown })
            .getSpaceCtx()
        ).toThrow("name a space");
      } finally {
        await runtime.dispose();
      }
    });

    it("lazily builds a distinct, cached context for a foreign space", async () => {
      const { processor, runtime, homeSpace } = makeProcessorState();
      const spaceB = (await Identity.fromPassphrase(
        "runtime-processor-space-b",
      )).did();
      try {
        const ctxB = processor.getSpaceCtx(spaceB);
        expect(ctxB).not.toBe(processor.cc);
        expect(ctxB.getSpace()).toBe(spaceB);
        // Cached: the same context comes back, and the home context is intact.
        expect(processor.getSpaceCtx(spaceB)).toBe(ctxB);
        expect(processor.getSpaceCtx(homeSpace)).toBe(processor.cc);
      } finally {
        await runtime.dispose();
      }
    });

    describe("handlePageGet()", () => {
      it("resolves the page in the space it is given", async () => {
        const { processor, runtime, homeSpace } = makeProcessorState();
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
    });

    describe("handleRuntimeSynced()", () => {
      it("awaits every opened space, naming none", async () => {
        const { processor, runtime } = makeProcessorState();
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
    });

    describe("handleIdle()", () => {
      it("awaits commit-durability quiescence, not plain idle", async () => {
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
    });

    describe("watchSiteTable()", () => {
      it("uses the last usable entry per space without replacing an accepted route", async () => {
        const { runtime } = createRuntime();
        const registered: Array<[string, string]> = [];
        let resolveRegistered = () => {};
        const entriesRegistered = new Promise<void>((resolve) => {
          resolveRegistered = resolve;
        });
        const registeredRoute = "did:key:z6Mk-table-b" as MemorySpace;
        const registerSpaceHost = runtime.registerSpaceHost.bind(runtime);
        expect(registerSpaceHost(registeredRoute, "http://ipc-host.test/"))
          .toBe(true);
        Object.assign(runtime, {
          registerSpaceHost: (space: string, host: string) => {
            registered.push([space, host]);
            if (registered.length === 3) resolveRegistered();
            return registerSpaceHost(space as MemorySpace, host);
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
          { did: registeredRoute, host: "http://stale-table.test/" },
          { did: "did:key:z6Mk-table-c", host: "http://host-c.test/" },
          { did: "did:key:z6Mk-table-a", host: "http://host-a-new.test/" },
          { did: "did:key:z6Mk-table-a", host: "not a url" },
          {
            did: "did:key:z6Mk-table-credentials",
            host: "http://user@credentials.test/",
          },
          { did: "did:key:z6Mk-table-path", host: "http://path.test/api" },
          {
            did: "did:key:z6Mk-table-dot-path",
            host: "http://dot-path.test/api/..",
          },
          { did: "did:key:z6Mk-table-query", host: "http://query.test/?x=1" },
          { did: "did:key:z6Mk-table-fragment", host: "http://hash.test/#x" },
        ]);
        await tx.commit();

        const cc = new PiecesController(
          { as: cfcSigner, space: userDid },
          runtime,
        );
        const ProcessorConstructor = RuntimeProcessor as unknown as new (
          runtime: Runtime,
          cc: PiecesController,
          initSpace: MemorySpace,
          identity: Identity,
          telemetry: RuntimeTelemetry,
        ) => RuntimeProcessor;
        const processor = new ProcessorConstructor(
          runtime,
          cc,
          userDid,
          cfcSigner,
          new RuntimeTelemetry(),
        );
        try {
          processor.watchSiteTable();
          await entriesRegistered;
          expect(registered).toEqual([
            ["did:key:z6Mk-table-a", "http://host-a-new.test/"],
            [registeredRoute, "http://stale-table.test/"],
            ["did:key:z6Mk-table-c", "http://host-c.test/"],
          ]);
          expect(runtime.mappedHostFor(registeredRoute)).toBe(
            "http://ipc-host.test/",
          );
          const tableRoute = "did:key:z6Mk-table-a" as MemorySpace;
          expect(registerSpaceHost(tableRoute, "http://late-ipc.test/"))
            .toBe(false);
          expect(runtime.mappedHostFor(tableRoute)).toBe(
            "http://host-a-new.test/",
          );
        } finally {
          await processor.dispose();
        }
      });
    });

    describe("handleRegisterSpaceHost()", () => {
      it("forwards to the runtime and reports the verdict", () => {
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
    });

    describe("setMemoryMessageCompression()", () => {
      it("forwards the requested mode to storage", async () => {
        const modes: boolean[] = [];
        const processor = {
          runtime: {
            storageManager: {
              setMessageCompressionEnabled: (enabled: boolean) => {
                modes.push(enabled);
                return Promise.resolve();
              },
            },
          },
          setMemoryMessageCompression:
            RuntimeProcessor.prototype.setMemoryMessageCompression,
        } as unknown as RuntimeProcessor;
        await RuntimeProcessor.prototype.handleRequest.call(
          processor,
          {
            type: RequestType.SetMemoryMessageCompression,
            enabled: false,
          },
        );

        expect(modes).toEqual([false]);
      });
    });

    describe("piecesFor()", () => {
      it("returns only existing contexts, and creates none lazily", async () => {
        const { processor, runtime, homeSpace } = makeProcessorState();
        const spaceB = (await Identity.fromPassphrase(
          "runtime-processor-space-b",
        )).did();
        const piecesFor = (RuntimeProcessor.prototype as any).piecesFor;
        try {
          expect(piecesFor.call(processor, homeSpace)).toBe(processor.cc);
          expect(piecesFor.call(processor, spaceB)).toBeUndefined();
          const ctxB = processor.getSpaceCtx(spaceB);
          expect(piecesFor.call(processor, spaceB)).toBe(ctxB);
        } finally {
          await runtime.dispose();
        }
      });
    });
  });

  describe("RuntimeProcessor vdom mount render policy", () => {
    // S16 phase D: the host's render confidentiality ceiling must reach every
    // mount's reconciler — a ceiling configured at initialization that never
    // arrives at the egress surface is silently unbounded rendering.

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
        // Keyed as the processor keys a mount: by the mounting client's
        // scoped mount id, which for a call naming no client is the owner's.
        vdomMounts: new Map<
          string,
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
        const mount = state.vdomMounts.get("0 1");
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
      const caveatKind =
        "https://commonfabric.org/cfc/concepts/prompt-influence";
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

  describe("RuntimeProcessor handleVDomEvent dropped-event warning", () => {
    // handleVDomEvent forwards a main-thread DOM event to the owning mount's
    // reconciler. The reconciler's dispatchEvent returns false when no handler
    // is registered for the handlerId, meaning the event was dropped. The
    // processor surfaces that drop as a console.warn carrying the mountId and
    // handlerId so a silently-dropped click is traceable.

    const handleVDomEvent = (RuntimeProcessor.prototype as any).handleVDomEvent;

    function makeState(dispatchResult: boolean, calls: unknown[][]) {
      return {
        vdomMounts: new Map<string, { reconciler: unknown }>([
          [
            "0 7",
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
        "0 1",
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
        processor.handleNotification(
          { type: "vdom:bogus", mountId: 1 } as never,
        );
      } finally {
        console.warn = original;
      }
      expect(warnings.length).toBe(1);
      expect(events).toEqual([]);
      expect(acks).toEqual([]);
    });
  });

  describe("runtime-client pattern source view", () => {
    // `getPatternSources` reads two things: which patterns the graph is running,
    // and each one's program. Everything else on the runtime is beside the point
    // here, so the processor is those two answers and nothing more.

    const processorOver = (
      programs: Record<string, unknown>,
    ): RuntimeProcessor =>
      ({
        runtime: {
          scheduler: {
            getGraphSnapshot: () => ({
              nodes: Object.keys(programs).map((identity) => ({
                patternIdentity: { identity, symbol: "default" },
              })),
            }),
          },
          patternManager: {
            getPatternProgramBySync: (identity: string) => programs[identity],
          },
        },
      }) as unknown as RuntimeProcessor;

    const sourcesOf = (processor: RuntimeProcessor) =>
      RuntimeProcessor.prototype.getPatternSources.call(processor, {
        type: RequestType.GetPatternSources,
      } as GetPatternSourcesRequest);

    it("says which of a running pattern's files carry data", () => {
      const { patterns } = sourcesOf(processorOver({
        "cf:module/abc": {
          main: "/main.tsx",
          files: [
            { name: "/main.tsx", contents: "export default 1;" },
            { name: "/data/cities.json", contents: "[]" },
          ],
          dataFiles: ["/data/cities.json"],
        },
      }));
      expect(patterns.length).toBe(1);
      expect(patterns[0].files.map((file) => file.name)).toEqual([
        "/main.tsx",
        "/data/cities.json",
      ]);
      // Without this the view cannot tell the lookup table from the module.
      expect(patterns[0].dataFiles).toEqual(["/data/cities.json"]);
    });

    it("omits the list for a pattern that carries no data", () => {
      const { patterns } = sourcesOf(processorOver({
        "cf:module/abc": {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 1;" }],
        },
      }));
      expect(patterns[0].dataFiles).toBe(undefined);
    });

    it("omits a pattern whose program was never kept", () => {
      const { patterns } = sourcesOf(
        processorOver({ "cf:module/abc": undefined }),
      );
      expect(patterns).toEqual([]);
    });
  });

  describe("RuntimeProcessor SQLite IPC", () => {
    const ref: CellRef = {
      id: "of:database" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    const processorWith = (
      db: Record<string, unknown>,
      sqliteQuery: (...args: unknown[]) => Promise<unknown>,
    ) => {
      let pulled = false;
      const cell = {
        pull: () => {
          pulled = true;
          return Promise.resolve(db);
        },
        getRaw: () => pulled ? db : undefined,
        asSchema: () => ({ get: () => db }),
      };
      const runtime = {
        getCellFromLink: () => cell,
        storageManager: { open: () => ({ sqliteQuery }) },
      };
      return Object.assign(Object.create(RuntimeProcessor.prototype), {
        runtime,
      }) as RuntimeProcessor;
    };

    it("queries an unlabeled database through its storage provider", async () => {
      const calls: unknown[][] = [];
      const processor = processorWith(
        { id: "db-1", tables: { notes: {} }, scope: "user" },
        (...args) => {
          calls.push(args);
          return Promise.resolve({ rows: [{ title: "One" }] });
        },
      );

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT title FROM notes WHERE id = ?",
        params: {
          kind: "positional",
          values: [1],
        },
      })).resolves.toEqual({
        rows: [{ title: "One" }],
      });
      expect(calls).toEqual([[
        { id: "db-1", tables: { notes: {} }, scope: "user" },
        "SELECT title FROM notes WHERE id = ?",
        [1],
      ]]);
    });

    it("waits for a scoped database factory commit before loading its handle", async () => {
      const calls: string[] = [];
      const db = { id: "db-1", tables: { notes: {} }, scope: "user" };
      let committed = false;
      let loaded = false;
      const cell = {
        pull: () => {
          calls.push("pull");
          return Promise.resolve();
        },
        sync: () => {
          calls.push("sync");
          loaded = committed;
          return Promise.resolve(loaded ? db : undefined);
        },
        getRaw: () => loaded ? db : {},
        asSchema: () => ({ get: () => loaded ? db : undefined }),
      };
      const processor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          runtime: {
            getCellFromLink: () => cell,
            scheduler: {
              idleWithPendingCommits: () => {
                calls.push("commits");
                committed = true;
                return Promise.resolve();
              },
            },
            storageManager: {
              open: () => ({
                sqliteQuery: () => {
                  calls.push("query");
                  return Promise.resolve({ rows: [] });
                },
              }),
            },
          },
        },
      ) as RuntimeProcessor;

      await processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT * FROM notes",
      });

      expect(calls).toEqual(["pull", "commits", "sync", "query"]);
    });

    it("keeps SQLite BLOB parameters encoded across the storage boundary", async () => {
      const calls: unknown[][] = [];
      const processor = processorWith(
        { id: "db-1", tables: { blobs: {} } },
        (...args) => {
          calls.push(args);
          return Promise.resolve({
            rows: [{
              payload: new FabricBytes(new Uint8Array([1, 2, 3])),
            }],
          });
        },
      );
      const input = new FabricBytes(new Uint8Array([4, 5, 6]));

      const result = await processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT payload FROM blobs WHERE payload = ?",
        params: {
          kind: "positional",
          values: [input],
        },
      });

      const output = result.rows[0]!.payload;
      expect(output).toBeInstanceOf(FabricBytes);
      expect((output as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      const parameter = (calls[0]?.[2] as unknown[])[0];
      expect(parameter).toBeInstanceOf(FabricBytes);
      expect((parameter as FabricBytes).slice()).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    });

    it("lowers linked and nested SQLite bind values for storage", async () => {
      const calls: unknown[][] = [];
      const created = createRuntime();
      try {
        const linkedCell = created.runtime.getCell(
          cfcSigner.did(),
          `sqlite-linked-${crypto.randomUUID()}`,
        );
        const linked = createCellRef(linkedCell);
        const db = { id: "db-1", tables: { notes: {} } };
        let pulled = false;
        const source = {
          pull: () => {
            pulled = true;
            return Promise.resolve(db);
          },
          getRaw: () => pulled ? db : undefined,
          asSchema: () => ({ get: () => db }),
        };
        const runtime = {
          getCellFromLink: (cellRef: CellRef) =>
            cellRef.id === ref.id
              ? source
              : created.runtime.getCellFromLink(cellRef),
          storageManager: {
            open: () => ({
              sqliteQuery: (...args: unknown[]) => {
                calls.push(args);
                return Promise.resolve({ rows: [] });
              },
            }),
          },
        };
        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        const bytes = new FabricBytes(new Uint8Array([7, 8, 9]));

        await processor.handleSqliteQuery({
          type: RequestType.SqliteQuery,
          cell: ref,
          sql: "SELECT :linked_cf_link, :nested",
          params: {
            kind: "named",
            entries: [
              ["linked_cf_link", linked],
              [
                "nested",
                {
                  bytes,
                  links: [linked],
                },
              ],
            ],
          },
        });

        const params = calls[0]?.[2] as Record<string, unknown>;
        const nested = params.nested as {
          bytes: FabricBytes;
          links: unknown[];
        };
        expect(JSON.parse(params.linked_cf_link as string)).toEqual(
          nested.links[0],
        );
        expect(nested.bytes).toBeInstanceOf(FabricBytes);
        expect(nested.bytes.slice()).toEqual(new Uint8Array([7, 8, 9]));
      } finally {
        await created.runtime.dispose();
        await created.storageManager.close();
      }
    });

    it("preserves reserved SQLite column names in query rows", async () => {
      const row = Object.fromEntries([
        ["constructor", "constructor-value"],
        ["__proto__", "proto-value"],
      ]);
      const processor = processorWith(
        { id: "db-1", tables: { notes: {} } },
        () => Promise.resolve({ rows: [row] }),
      );

      const result = await processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: 'SELECT 1 AS "constructor", 2 AS "__proto__"',
      });

      expect(Object.hasOwn(result.rows[0]!, "constructor")).toBe(true);
      expect(Object.hasOwn(result.rows[0]!, "__proto__")).toBe(true);
      const resultRow = result.rows[0]!;
      const constructorValue = Object.getOwnPropertyDescriptor(
        resultRow,
        "constructor",
      )!.value;
      const prototypeValue = Object.getOwnPropertyDescriptor(
        resultRow,
        "__proto__",
      )!.value;
      expect(constructorValue).toBe("constructor-value");
      expect(prototypeValue).toBe("proto-value");
    });

    it("refuses a direct query whose result needs CFC provenance", async () => {
      let queried = false;
      const processor = processorWith({
        id: "db-1",
        tables: {
          notes: {
            properties: {
              secret: { ifc: { confidentiality: ["private"] } },
            },
          },
        },
      }, () => {
        queried = true;
        return Promise.resolve({ rows: [] });
      });

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT secret FROM notes",
      })).rejects.toThrow("query them inside a pattern");
      expect(queried).toBe(false);
    });

    it("rejects queries when the storage provider has no SQLite support", async () => {
      const processor = processorWith(
        { id: "db-1", tables: { notes: {} } },
        () => Promise.resolve({ rows: [] }),
      );
      (processor as unknown as {
        runtime: { storageManager: { open(): object } };
      }).runtime.storageManager.open = () => ({});

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT 1",
      })).rejects.toThrow("sqliteQuery unavailable");
    });

    it("rejects queries through a cell without a database reference", async () => {
      const processor = processorWith(
        { tables: { notes: {} } },
        () => Promise.resolve({ rows: [] }),
      );

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT 1",
      })).rejects.toThrow("valid SqliteDb cell handle");
    });

    it("rejects a database reference with an unknown scope", async () => {
      const db = { id: "db-1", tables: { notes: {} }, scope: "tenant" };
      const processor = processorWith(
        db,
        () => Promise.resolve({ rows: [] }),
      );

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT 1",
      })).rejects.toThrow("Invalid SQLite database scope: tenant");

      let edited = false;
      const cell = {
        pull: () => Promise.resolve(db),
        getRaw: () => db,
        asSchema: () => ({ get: () => db }),
      };
      const execProcessor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          runtime: {
            getCellFromLink: () => cell,
            editWithRetry: () => {
              edited = true;
              return Promise.resolve({ ok: undefined });
            },
          },
        },
      ) as RuntimeProcessor;
      await expect(execProcessor.handleSqliteExec({
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "DELETE FROM notes",
      })).rejects.toThrow("Invalid SQLite database scope: tenant");
      expect(edited).toBe(false);
    });

    it("rejects a database reference with a non-string owner", async () => {
      const processor = processorWith(
        { id: "db-1", tables: { notes: {} }, owner: { id: "not-a-did" } },
        () => Promise.resolve({ rows: [] }),
      );

      await expect(processor.handleSqliteQuery({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT 1",
      })).rejects.toThrow("Invalid SQLite database owner");
    });

    it("commits writes through the database cell's transactional exec", async () => {
      const calls: unknown[][] = [];
      const db = { id: "db-1", tables: { notes: {} } };
      const cell = {
        pull: () => {
          calls.push(["pull"]);
          return Promise.resolve(db);
        },
        getRaw: () => db,
        asSchema: () => ({ get: () => db }),
        withTx: (tx: unknown) => ({
          getRaw: () => db,
          exec: (sql: string, params: unknown) => calls.push([tx, sql, params]),
        }),
      };
      const tx = { id: "transaction" };
      const runtime = {
        getCellFromLink: () => cell,
        editWithRetry: (edit: (tx: unknown) => void) => {
          edit(tx);
          return Promise.resolve({ ok: undefined });
        },
      };
      const processor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        { runtime },
      ) as RuntimeProcessor;

      await processor.handleSqliteExec({
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "INSERT INTO notes (title) VALUES (:title)",
        params: {
          kind: "named",
          entries: [["title", "New"]],
        },
      });

      expect(calls).toEqual([[
        "pull",
      ], [
        tx,
        "INSERT INTO notes (title) VALUES (:title)",
        { title: "New" },
      ]]);
    });

    it("uses durable labels for Cells bound to direct SQLite writes", async () => {
      const signer = await Identity.fromPassphrase(
        `sqlite-durable-label-${crypto.randomUUID()}`,
      );
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost/"),
        storageManager,
        experimental: { serverExecution: true },
      });

      try {
        const secret = runtime.getCell(
          space,
          "sqlite-durable-secret",
          { type: "string", ifc: { confidentiality: ["secret"] } },
        );
        await secret.sync();
        {
          const tx = runtime.edit();
          secret.withTx(tx).set("classified");
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }

        const dbRef: SqliteDbRef = {
          id: `of:sqlite-durable-label-${crypto.randomUUID()}`,
          tables: {
            documents: {
              type: "object",
              properties: {
                id: {
                  type: "integer",
                  sqlType: "integer primary key",
                },
                target_cf_link: {
                  type: "string",
                  sqlType: "text",
                  ifc: { maxConfidentiality: [] },
                },
              },
              required: [],
            },
          },
        };
        const database = runtime.getCell(space, "sqlite-durable-db");
        await database.sync();
        {
          const tx = runtime.edit();
          database.withTx(tx).set(dbRef);
          expect((await tx.commit()).error).toBeUndefined();
        }
        await storageManager.synced();

        const processor = Object.assign(
          Object.create(RuntimeProcessor.prototype),
          { runtime },
        ) as RuntimeProcessor;
        const exec = (id: number) =>
          processor.handleSqliteExec({
            type: RequestType.SqliteExec,
            cell: createCellRef(database),
            sql: "INSERT INTO documents (id, target_cf_link) VALUES (?, ?)",
            params: {
              kind: "positional",
              values: [
                id,
                createCellRef(secret),
              ],
            },
          });

        await expect(exec(1)).rejects.toThrow("exceeds its maxConfidentiality");

        const replica = storageManager.open(space).replica;
        const link = secret.getAsNormalizedFullLink();
        const durableDocument = replica.getDocument(link.id, link.scope);
        expect(durableDocument).toBeDefined();
        const verdict = Promise.withResolvers<{
          withdrawn: { message: string };
        }>();
        const sealed = replica.sealNative!(
          {
            operations: [{
              op: "set",
              id: link.id,
              type: "application/json",
              value: {
                ...(durableDocument as Record<string, unknown>),
                cfc: { version: 1, labelMap: { version: 1, entries: [] } },
              } as never,
            }],
          },
          undefined,
          verdict.promise,
          { speculative: true },
        );
        try {
          expect(cfcLabelViewForCell(secret)).toBeUndefined();
          await expect(exec(2)).rejects.toThrow(
            "exceeds its maxConfidentiality",
          );
          const rows = await storageManager.open(space).sqliteQuery!(
            dbRef,
            "SELECT id FROM documents ORDER BY id",
          );
          expect(rows.rows).toEqual([]);
        } finally {
          verdict.resolve({ withdrawn: { message: "test complete" } });
          await sealed.settled;
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("materializes a scoped database handle in the same direct transaction as its first write", async () => {
      const calls: unknown[][] = [];
      const db = {
        id: "db-user",
        tables: { notes: {} },
        scope: "user" as const,
        owner: "did:key:alice",
      };
      const cell = {
        pull: () => Promise.resolve(db),
        getRaw: () => db,
        asSchema: () => ({ get: () => db }),
        withTx: (tx: unknown) => ({
          getRaw: () => undefined,
          asSchema: () => ({
            set: (value: unknown) => calls.push([tx, "set", value]),
          }),
          exec: (sql: string, params: unknown) =>
            calls.push([
              tx,
              "exec",
              sql,
              params,
            ]),
        }),
      };
      const tx = { id: "transaction" };
      const processor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          runtime: {
            getCellFromLink: () => cell,
            editWithRetry: (edit: (tx: unknown) => void) => {
              edit(tx);
              return Promise.resolve({ ok: undefined });
            },
          },
        },
      ) as RuntimeProcessor;

      await processor.handleSqliteExec({
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "INSERT INTO notes (title) VALUES (?)",
        params: {
          kind: "positional",
          values: ["First"],
        },
      });

      expect(calls).toEqual([
        [tx, "set", db],
        [
          tx,
          "exec",
          "INSERT INTO notes (title) VALUES (?)",
          ["First"],
        ],
      ]);
    });

    it("reports a transactional SQLite write failure", async () => {
      const db = { id: "db-1", tables: { notes: {} } };
      const cell = {
        pull: () => Promise.resolve(db),
        getRaw: () => db,
        asSchema: () => ({ get: () => db }),
        withTx: () => ({ getRaw: () => db, exec: () => {} }),
      };
      const processor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          runtime: {
            getCellFromLink: () => cell,
            editWithRetry: () =>
              Promise.resolve({ error: { message: "write refused" } }),
          },
        },
      ) as RuntimeProcessor;

      await expect(processor.handleSqliteExec({
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "DELETE FROM notes",
      })).rejects.toThrow("write refused");
    });

    it("routes SQLite requests through the processor dispatch", async () => {
      const processor = Object.assign(
        Object.create(RuntimeProcessor.prototype),
        {
          handleSqliteQuery: () => Promise.resolve({ rows: [{ value: 1 }] }),
          handleSqliteExec: () => Promise.resolve(),
        },
      ) as RuntimeProcessor;

      await expect(processor.handleRequest({
        type: RequestType.SqliteQuery,
        cell: ref,
        sql: "SELECT 1 AS value",
      })).resolves.toEqual({ rows: [{ value: 1 }] });
      await expect(processor.handleRequest({
        type: RequestType.SqliteExec,
        cell: ref,
        sql: "DELETE FROM notes",
      })).resolves.toBeUndefined();
    });
  });

  describe("RuntimeProcessor multi-client namespacing", () => {
    // One worker runs one runtime and serves several documents at once. Every
    // id a client supplies is minted inside that document -- a VDOM mount id
    // comes from a counter that starts at 1 in each of them -- so what one
    // client calls mount 1 and what another calls mount 1 are two mounts, and
    // a cell two documents both watch is two subscriptions. Each test here
    // holds one client's work still while another client's is set up, torn
    // down, or fed.

    type PostedMessage = Record<string, unknown>;

    function testClient(id: number) {
      const posted: PostedMessage[] = [];
      const client: WorkerClient = {
        id,
        post: (message) => {
          posted.push(message as PostedMessage);
          return true;
        },
      };
      return { client, posted };
    }

    const cellRef = {
      space: cfcSigner.did(),
      id: `of:${fid("multi-client-cell")}`,
      path: [],
      type: "application/json",
    } as unknown as CellRef;

    describe("cell subscriptions", () => {
      function subscriptionHarness() {
        const cancelled: number[] = [];
        const sinks: Array<(value: unknown, cfcLabel: unknown) => void> = [];
        const processor = {
          subscriptions: new Map<string, () => void>(),
          runtime: {
            getCellFromLink: () => ({
              sink: (
                callback: (value: unknown, cfcLabel: unknown) => void,
              ) => {
                const nth = sinks.push(callback);
                return () => cancelled.push(nth);
              },
            }),
          },
        } as unknown as RuntimeProcessor;
        return { processor, sinks, cancelled };
      }

      const subscribe = (
        processor: RuntimeProcessor,
        client: WorkerClient,
      ) =>
        RuntimeProcessor.prototype.handleCellSubscribe.call(processor, {
          type: RequestType.CellSubscribe,
          cell: cellRef,
        }, client);

      const unsubscribe = (
        processor: RuntimeProcessor,
        client: WorkerClient,
      ) =>
        RuntimeProcessor.prototype.handleCellUnsubscribe.call(processor, {
          type: RequestType.CellUnsubscribe,
          cell: cellRef,
        }, client);

      it("gives each client its own subscription to the same cell", () => {
        const { processor, sinks } = subscriptionHarness();
        expect(subscribe(processor, testClient(1).client)).toEqual({
          value: true,
        });
        expect(subscribe(processor, testClient(2).client)).toEqual({
          value: true,
        });
        expect(sinks).toHaveLength(2);
      });

      it("returns `false` for a second subscription by the same client", () => {
        const { processor, sinks } = subscriptionHarness();
        const { client } = testClient(1);
        expect(subscribe(processor, client)).toEqual({ value: true });
        expect(subscribe(processor, client)).toEqual({ value: false });
        expect(sinks).toHaveLength(1);
      });

      it("keeps one client's feed running when another unsubscribes the same cell", async () => {
        const { processor, sinks, cancelled } = subscriptionHarness();
        const first = testClient(1);
        const second = testClient(2);
        subscribe(processor, first.client);
        subscribe(processor, second.client);

        expect(unsubscribe(processor, first.client)).toEqual({ value: true });
        expect(cancelled).toEqual([1]);

        sinks[1]({ n: 2 }, undefined);
        // The sink posts from a microtask, so the subscription response
        // returns before the notification.
        await Promise.resolve();

        expect(second.posted).toHaveLength(1);
        expect(second.posted[0].type).toBe(NotificationType.CellUpdate);
        expect(first.posted).toEqual([]);
      });

      it("returns `false` for an unsubscribe of another client's subscription", () => {
        const { processor, cancelled } = subscriptionHarness();
        subscribe(processor, testClient(1).client);
        expect(unsubscribe(processor, testClient(2).client)).toEqual({
          value: false,
        });
        expect(cancelled).toEqual([]);
      });
    });

    describe("VDOM mounts", () => {
      const handleVDomMount = (RuntimeProcessor.prototype as unknown as {
        handleVDomMount: (
          this: unknown,
          request: unknown,
          client: WorkerClient,
        ) => unknown;
      }).handleVDomMount;
      const handleVDomUnmount = RuntimeProcessor.prototype.handleVDomUnmount;

      async function mountState() {
        const { runtime } = createRuntime();
        const space = cfcSigner.did();
        const tx = runtime.edit();
        const cell = runtime.getCell<string>(
          space,
          "multi-client-vdom-mount",
          undefined,
          tx,
        );
        cell.set("hello");
        const commit = await tx.commit();
        expect(commit.ok !== undefined).toBe(true);

        const state = {
          runtime,
          vdomMounts: new Map<
            string,
            { reconciler: unknown; cancel: () => void }
          >(),
          vdomBatchIdCounter: 0,
          renderDeclassificationPolicy: "allow",
          renderConfidentialityCeiling: undefined,
          handleVDomUnmount,
        };
        const link = cell.getAsNormalizedFullLink() as unknown as CellRef;
        return { runtime, state, link };
      }

      it("keeps one client's mount when another mounts under the same mount id", async () => {
        const { runtime, state, link } = await mountState();
        const first = testClient(1);
        const second = testClient(2);
        const hadPostMessage = "postMessage" in globalThis;
        const originalPostMessage =
          (globalThis as { postMessage?: unknown }).postMessage;
        (globalThis as { postMessage?: unknown }).postMessage = () => {};
        try {
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, first.client);
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, second.client);

          expect(state.vdomMounts.size).toBe(2);
        } finally {
          await runtime.dispose();
          if (hadPostMessage) {
            (globalThis as { postMessage?: unknown }).postMessage =
              originalPostMessage;
          } else {
            delete (globalThis as { postMessage?: unknown }).postMessage;
          }
        }
      });

      it("replaces a client's own mount when it mounts that id again", async () => {
        // Scoping the key changed which mounts collide, not what a collision
        // does: one client re-using its own mount id still replaces what was
        // there, and is left holding one mount rather than two.
        const { runtime, state, link } = await mountState();
        const { client } = testClient(1);
        const hadPostMessage = "postMessage" in globalThis;
        const originalPostMessage =
          (globalThis as { postMessage?: unknown }).postMessage;
        (globalThis as { postMessage?: unknown }).postMessage = () => {};
        try {
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, client);
          const first = state.vdomMounts.get("1 1");
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, client);

          expect(state.vdomMounts.size).toBe(1);
          expect(state.vdomMounts.get("1 1")).not.toBe(first);
        } finally {
          await runtime.dispose();
          if (hadPostMessage) {
            (globalThis as { postMessage?: unknown }).postMessage =
              originalPostMessage;
          } else {
            delete (globalThis as { postMessage?: unknown }).postMessage;
          }
        }
      });

      it("sends each mount's batches to the client that mounted it", async () => {
        const { runtime, state, link } = await mountState();
        const first = testClient(1);
        const second = testClient(2);
        const hadPostMessage = "postMessage" in globalThis;
        const originalPostMessage =
          (globalThis as { postMessage?: unknown }).postMessage;
        const strayPosts: unknown[] = [];
        (globalThis as { postMessage?: unknown }).postMessage = (
          message: unknown,
        ) => {
          strayPosts.push(message);
        };
        try {
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, first.client);
          handleVDomMount.call(state, {
            type: RequestType.VDomMount,
            mountId: 1,
            cell: link,
          }, second.client);
          // The reconciler flushes its ops on a microtask.
          await Promise.resolve();
          await Promise.resolve();

          const batches = (posted: PostedMessage[]) =>
            posted.filter((message) =>
              message.type === NotificationType.VDomBatch
            );
          expect(batches(first.posted).length).toBeGreaterThan(0);
          expect(batches(second.posted).length).toBeGreaterThan(0);
          expect(strayPosts).toEqual([]);
        } finally {
          await runtime.dispose();
          if (hadPostMessage) {
            (globalThis as { postMessage?: unknown }).postMessage =
              originalPostMessage;
          } else {
            delete (globalThis as { postMessage?: unknown }).postMessage;
          }
        }
      });
    });

    describe("mountErrorSink()", () => {
      it("posts a render error to the client that mounted, and no other", () => {
        const mounting = testClient(1);
        const other = testClient(2);
        mountErrorSink(mounting.client)(new Error("render blew up"));
        expect(mounting.posted).toHaveLength(1);
        expect(mounting.posted[0].type).toBe(NotificationType.ErrorReport);
        expect(mounting.posted[0].message).toBe("render blew up");
        expect(other.posted).toEqual([]);
      });

      it("carries a compiler-stack failure's code, so the shell can act on it", () => {
        const mounting = testClient(1);
        mountErrorSink(mounting.client)(
          new CompilerStackLoadError(new TypeError("chunk fetch failed")),
        );
        expect(mounting.posted[0].code).toBe(
          RuntimeErrorCode.CompilerStackLoadFailed,
        );
      });
    });

    describe("event routing", () => {
      function eventState() {
        const dispatched: Array<{ mount: string; handlerId: number }> = [];
        const acknowledged: Array<{ mount: string; batchId: number }> = [];
        const reconciler = (mount: string) => ({
          dispatchEvent: (handlerId: number) => {
            dispatched.push({ mount, handlerId });
            return true;
          },
          acknowledgeBatchApplied: (batchId: number) => {
            acknowledged.push({ mount, batchId });
          },
          unmount: () => {},
        });
        const processor = Object.create(
          RuntimeProcessor.prototype,
        ) as RuntimeProcessor;
        (processor as unknown as { vdomMounts: unknown }).vdomMounts = new Map([
          ["1 1", { reconciler: reconciler("first"), cancel: () => {} }],
          ["2 1", { reconciler: reconciler("second"), cancel: () => {} }],
        ]);
        return { processor, dispatched, acknowledged };
      }

      it("routes a DOM event to the mount of the client that sent it", () => {
        const { processor, dispatched } = eventState();
        processor.handleNotification({
          type: ClientNotificationType.VDomEvent,
          mountId: 1,
          handlerId: 7,
          event: { type: "click" } as never,
          nodeId: 3,
        }, testClient(2).client);
        expect(dispatched).toEqual([{ mount: "second", handlerId: 7 }]);
      });

      it("routes a batch acknowledgement to the mount of the client that sent it", () => {
        const { processor, acknowledged } = eventState();
        processor.handleNotification({
          type: ClientNotificationType.VDomBatchApplied,
          mountId: 1,
          batchId: 42,
        }, testClient(1).client);
        expect(acknowledged).toEqual([{ mount: "first", batchId: 42 }]);
      });
    });

    describe("operation sessions and subscriptions", () => {
      // A subscription id and a session id are UUIDs the client mints, which
      // is convention rather than protocol: nothing on the wire stops one
      // client naming another's. Each of these hands a client the other's id.

      function operationState() {
        const cancelled: string[] = [];
        const processor = Object.create(
          RuntimeProcessor.prototype,
        ) as RuntimeProcessor;
        const state = processor as unknown as {
          operationSubscriptions: Map<string, unknown>;
          operationSessions: Map<string, unknown>;
        };
        state.operationSubscriptions = new Map([
          ["sub-of-first", {
            cancelled: false,
            cancel: () => cancelled.push("first"),
            client: testClient(1).client,
            sessionKey: "session-of-first",
          }],
        ]);
        state.operationSessions = new Map([
          ["session-of-first", {
            cellKey: "cell",
            target: {},
            subscriptions: new Set(["sub-of-first"]),
            clientId: 1,
          }],
        ]);
        return { processor, state, cancelled };
      }

      it("returns `false` when a client unsubscribes another client's subscription", () => {
        const { processor, state, cancelled } = operationState();
        expect(
          processor.handleOperationUnsubscribe({
            type: RequestType.OperationUnsubscribe,
            subscriptionId: "sub-of-first",
          }, testClient(2).client),
        ).toEqual({ value: false });
        expect(cancelled).toEqual([]);
        expect(state.operationSubscriptions.has("sub-of-first")).toBe(true);
      });

      it("returns `true` when the subscribing client unsubscribes its own", () => {
        const { processor, state, cancelled } = operationState();
        expect(
          processor.handleOperationUnsubscribe({
            type: RequestType.OperationUnsubscribe,
            subscriptionId: "sub-of-first",
          }, testClient(1).client),
        ).toEqual({ value: true });
        expect(cancelled).toEqual(["first"]);
        expect(state.operationSubscriptions.has("sub-of-first")).toBe(false);
      });

      it("returns `false` when a client closes another client's session", () => {
        const { processor, state } = operationState();
        expect(
          processor.handleOperationSessionClose({
            type: RequestType.OperationSessionClose,
            operationSessionId: "session-of-first",
          }, testClient(2).client),
        ).toEqual({ value: false });
        expect(state.operationSessions.has("session-of-first")).toBe(true);
      });

      it("returns `true` when the owning client closes its own session", () => {
        const { processor, state } = operationState();
        expect(
          processor.handleOperationSessionClose({
            type: RequestType.OperationSessionClose,
            operationSessionId: "session-of-first",
          }, testClient(1).client),
        ).toEqual({ value: true });
        expect(state.operationSessions.has("session-of-first")).toBe(false);
      });
    });

    describe("disposeClient()", () => {
      function departureState() {
        const cancelled: string[] = [];
        const unmounted: string[] = [];
        const processor = Object.create(
          RuntimeProcessor.prototype,
        ) as RuntimeProcessor;
        const state = processor as unknown as {
          subscriptions: Map<string, () => void>;
          operationSubscriptions: Map<string, unknown>;
          operationSessions: Map<string, {
            cellKey: string;
            target: unknown;
            subscriptions: Set<string>;
            clientId: number;
          }>;
          vdomMounts: Map<string, unknown>;
          runtime: unknown;
        };
        state.subscriptions = new Map([
          ["1 cell-a", () => cancelled.push("first/cell-a")],
          ["2 cell-a", () => cancelled.push("second/cell-a")],
        ]);
        state.operationSubscriptions = new Map([
          ["op-of-first", {
            cancelled: false,
            cancel: () => cancelled.push("first/op"),
            client: testClient(1).client,
            sessionKey: "session-of-first",
          }],
          ["op-of-second", {
            cancelled: false,
            cancel: () => cancelled.push("second/op"),
            client: testClient(2).client,
            sessionKey: "session-of-second",
          }],
        ]);
        state.operationSessions = new Map([
          ["session-of-first", {
            cellKey: "cell",
            target: {},
            subscriptions: new Set(["op-of-first"]),
            clientId: 1,
          }],
          ["session-of-second", {
            cellKey: "cell",
            target: {},
            subscriptions: new Set(["op-of-second"]),
            clientId: 2,
          }],
        ]);
        state.vdomMounts = new Map([
          ["1 1", {
            reconciler: { unmount: () => unmounted.push("first/1") },
            cancel: () => cancelled.push("first/mount-1"),
          }],
          ["2 1", {
            reconciler: { unmount: () => unmounted.push("second/1") },
            cancel: () => cancelled.push("second/mount-1"),
          }],
        ]);
        state.runtime = {
          dispose: () => {
            throw new Error("the runtime must outlive a departing client");
          },
        };
        return { processor, state, cancelled, unmounted };
      }

      it("cancels only the departing client's subscriptions and mounts", () => {
        const { processor, state, cancelled, unmounted } = departureState();
        processor.disposeClient(testClient(1).client);
        expect(cancelled).toEqual([
          "first/cell-a",
          "first/op",
          "first/mount-1",
        ]);
        expect(unmounted).toEqual(["first/1"]);
        expect([...state.subscriptions.keys()]).toEqual(["2 cell-a"]);
        expect([...state.vdomMounts.keys()]).toEqual(["2 1"]);
      });

      it("stops the departing client's operation feeds and no other's", () => {
        const { processor, state } = departureState();
        processor.disposeClient(testClient(1).client);
        expect([...state.operationSubscriptions.keys()]).toEqual([
          "op-of-second",
        ]);
      });

      it("forgets the departing client's operation sessions and no other's", () => {
        const { processor, state } = departureState();
        processor.disposeClient(testClient(1).client);
        expect([...state.operationSessions.keys()]).toEqual([
          "session-of-second",
        ]);
      });

      it("forgets a session the departing client opened and never subscribed on", () => {
        // The unsubscribes reap a session as its last subscription goes, so
        // this sweep is what a session with none of its own needs: it holds a
        // target address nobody is reading, and nothing else would remove it.
        const { processor, state } = departureState();
        state.operationSessions.set("session-never-used", {
          cellKey: "cell",
          target: {},
          subscriptions: new Set<string>(),
          clientId: 1,
        });

        processor.disposeClient(testClient(1).client);

        expect([...state.operationSessions.keys()]).toEqual([
          "session-of-second",
        ]);
      });

      it("leaves the runtime running", () => {
        const { processor } = departureState();
        expect(() => processor.disposeClient(testClient(1).client)).not
          .toThrow();
      });
    });
  });
});
