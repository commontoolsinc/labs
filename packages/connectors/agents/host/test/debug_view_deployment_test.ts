// Agent-sessions debug view: deployment lifecycle. Shared fixtures live in
// `debug_view_support.ts`; see there for why the suite spans several files.

import type { Cell } from "../../../../runner/src/builder/types.ts";
import {
  debugCommandWriterAuthorization,
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
  describeAgentFabricTarget,
} from "../src/debug-view.ts";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
  agentPrincipalSchema,
  cellHasOwnerConfidentiality,
  cellHasOwnerProtection,
} from "@commonfabric/agents-connector/fabric-graph";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  identity,
  installDefaultPattern,
  newSharedServer,
  registeredPieceIds,
  sessionSnapshot,
  SHALLOW_PIECE_LIST_SCHEMA,
  SHALLOW_PIECE_SCHEMA,
  SharedServerStorageManager,
  sourceDescriptor,
} from "./debug_view_support.ts";

Deno.test("debug command authorization resolves local schema definitions", () => {
  assertEquals(
    debugCommandWriterAuthorization({
      resultSchema: {
        type: "object",
        properties: {
          commandAuthorization: { $ref: "#/$defs/CommandAuthorization" },
        },
        $defs: {
          CommandAuthorization: {
            ifc: { writeAuthorizedBy: ["verified-writer"] },
          },
        },
      },
    } as never),
    ["verified-writer"],
  );
});

Deno.test("debug deployment requires verified command authorization", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-command-authorization-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    assertEquals(
      describeAgentFabricTarget(target, session.space).ownerDid,
      session.as.did(),
    );
    const defaultLocation = defaultDebugPatternLocation();
    await assertRejects(
      () =>
        deployAgentSessionsDebugView(manager, target, {
          rootPath: defaultLocation.rootPath,
          mainPath: fromFileUrl(
            new URL(
              "./fixtures/debug-view-without-command-authorization.tsx",
              import.meta.url,
            ),
          ),
        }),
      Error,
      "debug view has no verified command writer authorization",
    );
    assertEquals(target.commandsAreBound(), false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment replaces a view when its pattern identity changes", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-pattern-replacement-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const [originalPieceId, alternatePieceId] = await Promise.all([
      deployAgentSessionsDebugView(manager, target),
      deployAgentSessionsDebugView(manager, target, alternateLocation),
    ]);

    assertNotEquals(alternatePieceId, originalPieceId);
    assertEquals(
      await deployAgentSessionsDebugView(
        manager,
        target,
        alternateLocation,
      ),
      alternatePieceId,
    );
    const registeredIds = await registeredPieceIds(defaultPattern);
    assertEquals(registeredIds, []);
    const originalPiece = await manager.getPieceCell(
      originalPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    assertNotEquals(originalPiece.getRaw(), undefined);
    assertNotEquals(originalPiece.getMetaRaw("patternIdentity"), undefined);
    const alternatePiece = await manager.get(
      alternatePieceId,
      false,
    );
    assertEquals(alternatePiece.name(), "Alternate agent sessions");
    const reinsertResult = await runtime.editWithRetry((tx) => {
      const registry = defaultPattern.asSchema(undefined).key("pieceRegistry")
        .resolveAsCell().asSchema(SHALLOW_PIECE_LIST_SCHEMA) as Cell<
          Cell<unknown>[]
        >;
      const registryWithTx = registry.withTx(tx);
      const current = registryWithTx.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error("pieceRegistry is not an array");
      }
      current.push(originalPiece.getAsLink({
        base: registryWithTx,
        includeSchema: true,
      }));
      registryWithTx.setRawUntyped(current);
    });
    if (reinsertResult.error) throw reinsertResult.error;
    assertEquals(
      await deployAgentSessionsDebugView(manager, target, alternateLocation),
      alternatePieceId,
    );
    assertEquals(
      (await registeredPieceIds(defaultPattern)).includes(originalPieceId),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment starts and restarts its registered view", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const debugPieceId = await deployAgentSessionsDebugView(manager, target);
    const piece = await manager.get(debugPieceId, false);

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    await manager.stopPiece(piece.getCell());
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      debugPieceId,
    );
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment removes a view that fails to start", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("debug start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment protects its result before starting", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-protection-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalSetupPersistent = manager.setupPersistent;
    const originalStartPiece = manager.startPiece;
    const originalEdit = runtime.edit;
    let rejectProtection = false;
    let startCount = 0;
    manager.setupPersistent = (async (...args) => {
      const piece = await originalSetupPersistent.apply(manager, args);
      rejectProtection = true;
      return piece;
    }) as typeof manager.setupPersistent;
    manager.startPiece = (async (...args) => {
      startCount++;
      return await originalStartPiece.apply(manager, args);
    }) as typeof manager.startPiece;
    runtime.edit = ((...args) => {
      if (rejectProtection) {
        throw new Error("debug result protection rejected");
      }
      return originalEdit.apply(runtime, args);
    }) as typeof runtime.edit;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug result protection rejected",
      );
    } finally {
      manager.setupPersistent = originalSetupPersistent;
      manager.startPiece = originalStartPiece;
      runtime.edit = originalEdit;
    }

    assertEquals(startCount, 0);
    assertEquals(await registeredPieceIds(defaultPattern), []);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment preserves a view when its replacement fails", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-replacement-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("replacement start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target, alternateLocation),
        Error,
        "replacement start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    const originalPiece = await manager.get(originalPieceId, false);
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rolls back an aborted registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-aborted-registration-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
    );
    const originalRegistration = registration.getRaw();
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const abortRegistration = async (
      location: ReturnType<typeof defaultDebugPatternLocation>,
      options: {
        abortAfterCommit?: boolean;
        interceptPrivateRegistration?: boolean;
      } = {},
    ): Promise<{ candidateWasStopped: boolean }> => {
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const controller = new AbortController();
      const originalStartPiece = manager.startPiece;
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      const originalStop = runtime.runner.stop.bind(runtime.runner);
      let candidatePiece: Cell<unknown> | undefined;
      let candidateWasStopped = false;
      let interceptRegistrationCommit = false;
      let commitCount = 0;
      manager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(manager, piece, options);
        if (typeof piece !== "string") candidatePiece = piece;
        interceptRegistrationCommit = true;
      }) as typeof manager.startPiece;
      runtime.runner.stop = ((piece) => {
        if (piece === candidatePiece) candidateWasStopped = true;
        return originalStop(piece);
      }) as typeof runtime.runner.stop;
      runtime.editWithRetry = (async (action, maxRetries) => {
        if (interceptRegistrationCommit) commitCount++;
        let shouldIntercept = false;
        const result = await originalEditWithRetry((transaction) => {
          const registrationBefore = transaction.readValueOrThrow(
            registration.getAsNormalizedFullLink(),
          );
          const result = action(transaction);
          const registrationAfter = transaction.readValueOrThrow(
            registration.getAsNormalizedFullLink(),
          );
          const registrationChanged = JSON.stringify(registrationBefore) !==
            JSON.stringify(registrationAfter);
          shouldIntercept = interceptRegistrationCommit &&
            (options.interceptPrivateRegistration
              ? registrationChanged
              : commitCount === 1);
          if (shouldIntercept) {
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              const result = await originalCommit();
              if (options.abortAfterCommit) {
                controller.abort(new Error("debug deployment cancelled"));
              }
              return result;
            };
          }
          return result;
        }, maxRetries);
        return result;
      }) as typeof runtime.editWithRetry;
      try {
        const deployment = deployAgentSessionsDebugView(
          manager,
          target,
          location,
          controller.signal,
        );
        await commitEntered.promise;
        if (!options.abortAfterCommit) {
          controller.abort(new Error("debug deployment cancelled"));
        }
        releaseCommit.resolve();
        await assertRejects(
          () => deployment,
          Error,
          "debug deployment cancelled",
        );
      } finally {
        releaseCommit.resolve();
        manager.startPiece = originalStartPiece;
        runtime.runner.stop = originalStop;
        runtime.editWithRetry = originalEditWithRetry;
      }
      return { candidateWasStopped };
    };

    const originalPiece = await manager.get(originalPieceId, false);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await abortRegistration(alternateLocation, {
      abortAfterCommit: true,
    });
    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);

    const abortedPrivateRegistration = await abortRegistration(
      alternateLocation,
      {
        abortAfterCommit: true,
        interceptPrivateRegistration: true,
      },
    );
    assertEquals(abortedPrivateRegistration.candidateWasStopped, true);
    assertEquals(registration.getRaw(), originalRegistration);
    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      originalPieceId,
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects stale registration across runtimes", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-race-${crypto.randomUUID()}`;
  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const readerManager = new PiecesController(readerSession, readerRuntime);
    await readerManager.synced();
    const defaultPattern = await installDefaultPattern(readerManager);
    const ownerDid = readerSession.as.did();
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
      ownerDid,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();

    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const writerManager = new PiecesController(writerSession, writerRuntime);
      await writerManager.synced();
      const registration = writerRuntime.getCell(
        writerSession.space,
        `agent-sessions-debug-registration:${ownerDid}`,
      );
      await registration.sync();
      const competingRegistration = {
        cause: "agent-sessions-debug:competing",
        pieceId: "fid1:competing-debug-piece",
        patternIdentity: "fid1:competing-debug-pattern",
        patternSymbol: "default",
        retiredCauses: [],
      };
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const originalStartPiece = readerManager.startPiece;
      const originalEditWithRetry = readerRuntime.editWithRetry.bind(
        readerRuntime,
      );
      let interceptRegistrationCommit = false;
      let intercepted = false;
      readerManager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(readerManager, piece, options);
        interceptRegistrationCommit = true;
      }) as typeof readerManager.startPiece;
      readerRuntime.editWithRetry = ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptRegistrationCommit && !intercepted) {
            intercepted = true;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof readerRuntime.editWithRetry;
      try {
        const defaultLocation = defaultDebugPatternLocation();
        const deployment = deployAgentSessionsDebugView(
          readerManager,
          target,
          {
            rootPath: defaultLocation.rootPath,
            mainPath: fromFileUrl(
              new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
            ),
          },
        );
        await commitEntered.promise;
        const competingResult = await writerRuntime.editWithRetry((tx) => {
          tx.setCfcImplementationIdentity({
            kind: "builtin",
            builtinId: AGENT_CONNECTOR_WRITER_ID,
          });
          registration.withTx(tx).asSchema(agentOwnerSchema(ownerDid))
            .setRawUntyped(competingRegistration);
        });
        if (competingResult.error) {
          throw competingResult.error;
        }
        releaseCommit.resolve();

        await assertRejects(
          () =>
            deployment,
          Error,
          "debug view registration changed during deployment",
        );
        assertEquals(registration.getRaw(), competingRegistration);
        assertEquals(
          await registeredPieceIds(defaultPattern),
          [],
        );
        await target.publish([{
          source: sourceDescriptor(),
          sessions: [sessionSnapshot(1)],
          errors: [],
          complete: true,
        }]);
        await readerRuntime.settled();
        const originalPiece = await readerManager.get(originalPieceId, false);
        assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      } finally {
        releaseCommit.resolve();
        readerManager.startPiece = originalStartPiece;
        readerRuntime.editWithRetry = originalEditWithRetry;
      }
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});

Deno.test("debug deployment refuses a pre-created unprotected piece", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-piece-squatting-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalSetupPersistent = manager.setupPersistent;
    let debugCause: string | undefined;
    manager.setupPersistent = ((...args) => {
      if (typeof args[2] === "string") debugCause = args[2];
      throw new Error("captured debug view cause");
    }) as typeof manager.setupPersistent;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "captured debug view cause",
      );
    } finally {
      manager.setupPersistent = originalSetupPersistent;
    }
    if (debugCause === undefined) {
      throw new Error("debug view cause was not set");
    }
    const squattedPiece = runtime.getCell(
      session.space,
      debugCause,
      SHALLOW_PIECE_SCHEMA,
    );
    const seed = runtime.edit();
    squattedPiece.withTx(seed).setRawUntyped({ spoofed: true });
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "refusing to adopt an unprotected debug view",
    );
    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        squattedPiece,
        session.as.did(),
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment refuses an unprotected registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-squatting-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
    );
    const squattedRegistration = {
      cause: "agent-sessions-debug:squatted",
      pieceId: "fid1:squatted-debug-piece",
      patternIdentity: "fid1:squatted-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    };
    const seed = runtime.edit();
    registration.withTx(seed).setRawUntyped(squattedRegistration);
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "refusing to adopt an unprotected debug registration",
    );
    assertEquals(registration.getRaw(), squattedRegistration);
    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        registration,
        session.as.did(),
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment requires the public piece registry", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-missing-registry-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const removed = await runtime.editWithRetry((tx) => {
      defaultPattern.withTx(tx).asSchema(undefined).key("pieceRegistry")
        .setRawUntyped(undefined);
    });
    if (removed.error) throw removed.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "default pattern does not expose pieceRegistry",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug registration rejects writes from another owner", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-owner-${crypto.randomUUID()}`;
  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const readerManager = new PiecesController(readerSession, readerRuntime);
    await readerManager.synced();
    const defaultPattern = await installDefaultPattern(readerManager);
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
      ownerDid: readerSession.as.did(),
    });
    const debugPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();
    assertEquals(await registeredPieceIds(defaultPattern), []);
    const registration = readerRuntime.getCell(
      readerSession.space,
      `agent-sessions-debug-registration:${readerSession.as.did()}`,
    );
    const originalRegistration = registration.getRaw();
    assertEquals(
      cellHasOwnerConfidentiality(
        readerRuntime.readTx(),
        registration,
        readerSession.as.did(),
      ),
      true,
    );
    const attack = readerRuntime.edit();
    attack.setCfcTrustSnapshot({
      id: "principal:did:key:other-owner",
      actingPrincipal: "did:key:other-owner",
    });
    attack.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    registration.withTx(attack).setRawUntyped({
      cause: "agent-sessions-debug:competing",
      pieceId: "fid1:competing-debug-piece",
      patternIdentity: "fid1:competing-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    });
    attack.prepareCfc();
    const result = await attack.commit();
    assertEquals(result.error !== undefined, true);

    const debugPiece = await readerManager.getPieceCell(
      debugPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    const runningPiece = await readerManager.get(debugPieceId, false);
    const argument = readerManager.getArgument(debugPiece);
    await argument.sync();
    assertEquals(
      cellHasOwnerProtection(
        readerRuntime.readTx(),
        argument,
        readerSession.as.did(),
      ),
      true,
    );
    const originalArgument = argument.getRaw();
    const argumentAttack = readerRuntime.edit();
    argumentAttack.setCfcTrustSnapshot({
      id: "principal:did:key:other-owner",
      actingPrincipal: "did:key:other-owner",
    });
    argumentAttack.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    argument.withTx(argumentAttack).setRawUntyped({
      ...(argument.getRaw() as Record<string, unknown>),
      ownerDid: "did:key:other-owner",
    });
    argumentAttack.prepareCfc();
    const argumentAttackResult = await argumentAttack.commit();
    assertEquals(argumentAttackResult.error !== undefined, true);
    assertEquals(argument.getRaw(), originalArgument);

    const ownerUpdate = readerRuntime.edit();
    ownerUpdate.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    argument.withTx(ownerUpdate).setRawUntyped({
      ...(argument.getRaw() as Record<string, unknown>),
      ownerDid: "did:key:other-owner",
    });
    ownerUpdate.prepareCfc();
    const ownerUpdateResult = await ownerUpdate.commit();
    if (ownerUpdateResult.error) throw ownerUpdateResult.error;
    await assertRejects(
      () => deployAgentSessionsDebugView(readerManager, target),
      Error,
      "contains different owner inputs",
    );
    assertEquals(registration.getRaw(), originalRegistration);
    assertNotEquals(debugPiece.getRaw(), undefined);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await readerRuntime.settled();
    assertEquals(await runningPiece.result.get(["sessionCount"]), 1);
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});

Deno.test("debug registration rejects another owner-scoped writer", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-writer-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const otherWriter = "another-owner-scoped-pattern";
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
      agentPrincipalSchema(session.as.did(), [otherWriter]),
    );
    const seed = runtime.edit();
    seed.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: otherWriter,
    });
    registration.withTx(seed).set({
      cause: "agent-sessions-debug:competing",
      pieceId: "fid1:competing-debug-piece",
      patternIdentity: "fid1:competing-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    });
    registration.withTx(seed).applyCfcSchemaToExistingValue();
    seed.prepareCfc();
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;
    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), registration, session.as.did()),
      true,
    );

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "writeAuthorizedBy cannot be weakened",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment reports a malformed piece registry", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-error-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const pieceRegistry = defaultPattern.asSchema(undefined)
      .key("pieceRegistry")
      .resolveAsCell();
    const malformedResult = await runtime.editWithRetry((tx) => {
      pieceRegistry.withTx(tx).setRawUntyped({ malformed: true });
    });
    if (malformedResult.error) throw malformedResult.error;
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "pieceRegistry is not an array",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects a replaced default pattern", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-root-race-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const replacementRoot = runtime.getCell(
      session.space,
      `replacement-default-pattern-${crypto.randomUUID()}`,
    );
    const replacementResult = await runtime.editWithRetry((tx) => {
      replacementRoot.withTx(tx).setRawUntyped({ replacement: true });
    });
    if (replacementResult.error) throw replacementResult.error;

    const originalGetDefaultPattern = manager.getDefaultPattern;
    let replaced = false;
    manager.getDefaultPattern = (async (runIt = true) => {
      const found = await originalGetDefaultPattern.call(manager, runIt);
      if (!replaced) {
        replaced = true;
        await manager.linkDefaultPattern(replacementRoot);
      }
      return found;
    }) as typeof manager.getDefaultPattern;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern changed during debug view deployment",
      );
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects an in-place registry change", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registry-race-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalStartPiece = manager.startPiece;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let injectRegistryChange = false;
    let registryChangeInjected = false;
    manager.startPiece = (async (piece, options) => {
      await originalStartPiece.call(manager, piece, options);
      injectRegistryChange = true;
    }) as typeof manager.startPiece;
    runtime.editWithRetry = (async (action, maxRetries) => {
      if (injectRegistryChange && !registryChangeInjected) {
        registryChangeInjected = true;
        const change = await originalEditWithRetry((tx) => {
          defaultPattern.withTx(tx).key("pieceRegistry").setRawUntyped([]);
        });
        if (change.error) throw change.error;
      }
      return await originalEditWithRetry(action, maxRetries);
    }) as typeof runtime.editWithRetry;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern registry changed during debug view deployment",
      );
    } finally {
      manager.startPiece = originalStartPiece;
      runtime.editWithRetry = originalEditWithRetry;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
