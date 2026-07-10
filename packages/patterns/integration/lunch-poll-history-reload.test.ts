/**
 * Cold-runtime persistence regression for lunch-poll visit history.
 *
 * A visit used to be appended as an anonymous array element. Its stored link
 * then lacked the HistoryEntry item schema: the warm writer could still report
 * historyCount=1, but a fresh runtime traversed `visits`/`recentVisits` as an
 * empty array and derived an empty mostRecentTitle. This test closes the first
 * controller entirely before reopening the same piece through a new runtime and
 * replica, so it exercises persisted link traversal rather than warm cache.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { type Cell, parseLink } from "@commonfabric/runner";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";
import { initializePiecesController } from "./pieces-controller.ts";

const VISIT_TITLE = "Persistence Cafe";
const VISIT_TIME = 1_703_000_000_000;

type StoredVisit = {
  id: string;
  title: string;
  loggedByName: string;
  loggedBy: unknown;
  wentAt: number;
  votes: unknown[];
};

const visitsFrom = (value: unknown): StoredVisit[] =>
  Array.isArray(value) ? value as StoredVisit[] : [];

describe("lunch poll history persistence", () => {
  it("rehydrates visits and history projections in a cold runtime", async () => {
    const server = StandaloneMemoryServer.start();
    const identity = await Identity.fromPassphrase(
      "lunch-poll history cold reload",
      { implementation: "noble" },
    );
    const spaceName = `lunch-poll-history-${crypto.randomUUID()}`;
    let pieceId = "";
    let visitId = "";

    try {
      const first = await initializePiecesController({
        apiUrl: server.url,
        identity,
        spaceName,
      });
      let cancelFirst: (() => void) | undefined;
      try {
        const sourcePath = join(
          import.meta.dirname!,
          "..",
          "lunch-poll",
          "main.tsx",
        );
        const rootPath = join(import.meta.dirname!, "..");
        const program = await first.manager().runtime.harness.resolve(
          new FileSystemProgramResolver(sourcePath, rootPath),
        );
        const piece = await first.create(program, { start: true });
        pieceId = piece.id;
        cancelFirst = first.manager().getResult(piece.getCell()).sink(() => {});

        await piece.result.set({ name: "Reload Host" }, ["joinAs"]);
        await piece.result.set(
          { title: VISIT_TITLE, wentAt: VISIT_TIME },
          ["logVisit"],
        );
        await first.manager().runtime.idle();
        await first.manager().synced();

        const warmVisits = visitsFrom(await piece.input.get(["visits"]));
        assertEquals(warmVisits.length, 1);
        assertEquals(warmVisits[0].title, VISIT_TITLE);
        visitId = warmVisits[0].id;
        assertMatch(visitId, /^h_/);
      } finally {
        cancelFirst?.();
        await first.dispose();
      }

      // A new controller means a new Runtime and empty replica/cache. Reopen by
      // durable piece id WITHOUT starting it: both the PerUser leaf and visit
      // entities must be readable from persisted input links alone.
      const second = await initializePiecesController({
        apiUrl: server.url,
        identity,
        spaceName,
      });
      let cancelSecond: (() => void) | undefined;
      try {
        const piece = await second.get(pieceId, false);

        const coldVisits = visitsFrom(await piece.input.get(["visits"]));
        assertEquals(coldVisits.length, 1);
        assertEquals(coldVisits[0].id, visitId);
        assertEquals(coldVisits[0].title, VISIT_TITLE);
        assertEquals(coldVisits[0].loggedByName, "Reload Host");
        assertEquals(coldVisits[0].wentAt, VISIT_TIME);
        assertEquals(coldVisits[0].votes, []);
        assertEquals(await piece.input.get(["myName"]), "Reload Host");

        await second.start(pieceId);
        cancelSecond = second.manager().getResult(piece.getCell()).sink(
          () => {},
        );
        await second.manager().runtime.idle();

        const recentVisits = visitsFrom(
          await piece.result.get(["recentVisits"]),
        );
        assertEquals(recentVisits.length, 1);
        assertEquals(recentVisits[0].id, visitId);
        assertEquals(recentVisits[0].title, VISIT_TITLE);
        assertEquals(await piece.result.get(["historyCount"]), 1);
        assertEquals(
          await piece.result.get(["mostRecentTitle"]),
          VISIT_TITLE,
        );
      } finally {
        cancelSecond?.();
        await second.dispose();
      }
    } finally {
      await server.close();
    }
  });

  it("merges concurrent visits while enforcing the newest-200 cap", async () => {
    const identity = await Identity.fromPassphrase(
      "lunch-poll concurrent history host",
      { implementation: "noble" },
    );
    const seededVisits = Array.from({ length: 199 }, (_, index) => ({
      id: `h_seed_${index}`,
      title: `Seed ${index}`,
      loggedByName: "Concurrent Host",
      loggedBy: null,
      wentAt: index,
      votes: [],
    }));
    const harness = await MultiRuntimeHarness.create({
      programPath: join(
        import.meta.dirname!,
        "..",
        "lunch-poll",
        "main.tsx",
      ),
      rootPath: join(import.meta.dirname!, ".."),
      input: { visits: seededVisits },
      sessions: [
        { label: "host-a", identity },
        { label: "host-b", identity },
      ],
    });

    try {
      const hostA = harness.session("host-a");
      const hostB = harness.session("host-b");
      await hostA.send("joinAs", { name: "Concurrent Host" });
      await harness.waitFor(
        "second host session resolves shared PerUser identity",
        async () => (await hostB.read(["isAdmin"])) === true,
      );

      await Promise.all([
        hostA.send(
          "logVisit",
          { title: "Concurrent A", wentAt: 10_000 },
          undefined,
          { idle: false },
        ),
        hostB.send(
          "logVisit",
          { title: "Concurrent B", wentAt: 10_001 },
          undefined,
          { idle: false },
        ),
      ]);

      await harness.waitFor(
        "both concurrent visits land under the cap",
        async () => {
          const rows = visitsFrom(await hostA.read(["recentVisits"]));
          const titles = rows.map((row) => row.title);
          return (await hostA.read(["historyCount"])) === 200 &&
            titles.includes("Concurrent A") &&
            titles.includes("Concurrent B");
        },
      );

      for (const session of [hostA, hostB]) {
        const rows = visitsFrom(await session.read(["recentVisits"]));
        const titles = rows.map((row) => row.title);
        assert(titles.includes("Concurrent A"));
        assert(titles.includes("Concurrent B"));
        assertEquals(await session.read(["historyCount"]), 200);
        assertEquals(
          await session.read(["mostRecentTitle"]),
          "Concurrent B",
        );
      }
    } finally {
      await harness.dispose();
    }
  });

  it("preserves a generic opaque schema-less target on log and clears its membership explicitly", async () => {
    const server = StandaloneMemoryServer.start();
    const hostIdentity = await Identity.fromPassphrase(
      "lunch-poll opaque history",
      { implementation: "noble" },
    );
    const opaqueIdentity = await Identity.fromPassphrase(
      "lunch-poll opaque history other-scope writer",
      { implementation: "noble" },
    );
    const spaceName = `lunch-poll-opaque-${crypto.randomUUID()}`;
    const opaqueValue: StoredVisit = {
      id: "h_opaque_schema_less",
      title: "Legacy Cafe",
      loggedByName: "Opaque Host",
      loggedBy: null,
      wentAt: VISIT_TIME - 1,
      votes: [],
    };
    let pieceId = "";
    let originalRawLink: unknown;
    let originalLinkIdentity:
      | {
        id: string;
        path: readonly PropertyKey[];
        space: string;
        scope: "space" | "user" | "session";
      }
      | undefined;

    try {
      // Create the real lunchpoll and establish its host identity first.
      const first = await initializePiecesController({
        apiUrl: server.url,
        identity: hostIdentity,
        spaceName,
      });
      let cancelFirst: (() => void) | undefined;
      try {
        const sourcePath = join(
          import.meta.dirname!,
          "..",
          "lunch-poll",
          "main.tsx",
        );
        const rootPath = join(import.meta.dirname!, "..");
        const program = await first.manager().runtime.harness.resolve(
          new FileSystemProgramResolver(sourcePath, rootPath),
        );
        const piece = await first.create(program, { start: true });
        pieceId = piece.id;
        cancelFirst = first.manager().getResult(piece.getCell()).sink(() => {});
        await piece.result.set({ name: "Opaque Host" }, ["joinAs"]);
      } finally {
        cancelFirst?.();
        await first.dispose();
      }

      // Generic opaque-membership safety fixture (not an exact reconstruction
      // of the live space-scoped pre-fix link): a second identity writes a
      // complete HistoryEntry into its PerUser overlay and places that
      // schema-less link into the shared visits list. The document is real and
      // durable, while its different user scope makes it deterministically
      // opaque to the host identity.
      const opaqueWriter = await initializePiecesController({
        apiUrl: server.url,
        identity: opaqueIdentity,
        spaceName,
      });
      try {
        const piece = await opaqueWriter.get(pieceId, false);
        const argument = await piece.input.getCell() as Cell<{
          visits: StoredVisit[];
        }>;
        const runtime = opaqueWriter.manager().runtime;
        const opaque = runtime.getCell<StoredVisit>(
          opaqueWriter.manager().getSpace(),
          { test: "schema-less lunch history", id: crypto.randomUUID() },
          undefined,
          undefined,
          "user",
        );
        assertEquals(
          opaque.getAsNormalizedFullLink().schema,
          undefined,
          "fixture target must not carry HistoryEntry schema",
        );
        const { error } = await runtime.editWithRetry((tx) => {
          opaque.withTx(tx).set(opaqueValue);
          argument.withTx(tx).key("visits").set([opaque.withTx(tx)]);
        });
        assert(!error, error?.message);
        await runtime.idle();
        await opaqueWriter.manager().synced();

        const visitsCell = argument.key("visits");
        const raw = visitsCell.getRaw();
        assert(Array.isArray(raw));
        assertEquals(raw.length, 1);
        originalRawLink = raw[0];
        const parsed = parseLink(originalRawLink, visitsCell);
        assert(parsed, "schema-less membership must still be a link");
        originalLinkIdentity = {
          id: parsed.id,
          path: [...parsed.path],
          space: parsed.space,
          scope: parsed.scope,
        };
        assertEquals(parsed.scope, "user");
        assertEquals(parsed.schema, undefined);
        assertEquals(opaque.getRaw(), opaqueValue);
      } finally {
        await opaqueWriter.dispose();
      }

      // Reopen through an empty replica so the test cannot succeed from the
      // opaque writer's in-memory entity/schema cache.
      const second = await initializePiecesController({
        apiUrl: server.url,
        identity: hostIdentity,
        spaceName,
      });
      let cancelSecond: (() => void) | undefined;
      try {
        const piece = await second.get(pieceId, false);
        const argument = await piece.input.getCell() as Cell<{
          visits: StoredVisit[];
        }>;
        const visitsCell = argument.key("visits");
        await visitsCell.sync();
        const coldRaw = visitsCell.getRaw();
        assert(Array.isArray(coldRaw));
        assertEquals(coldRaw.length, 1);
        assertEquals(coldRaw[0], originalRawLink);
        assertEquals(visitsFrom(await piece.input.get(["visits"])), []);

        await second.start(pieceId);
        cancelSecond = second.manager().getResult(piece.getCell()).sink(
          () => {},
        );
        await second.manager().runtime.idle();
        await piece.result.set(
          { title: "Readable New Visit", wentAt: VISIT_TIME },
          ["logVisit"],
        );
        await second.manager().runtime.idle();
        await second.manager().synced();

        const rawAfterLog = visitsCell.getRaw();
        assert(Array.isArray(rawAfterLog));
        assertEquals(
          rawAfterLog.length,
          2,
          "logging must retain the opaque membership and append the keyed row",
        );
        const survivingOpaqueLink = rawAfterLog.find((candidate) => {
          const parsed = parseLink(candidate, visitsCell);
          return parsed?.id === originalLinkIdentity?.id &&
            parsed?.space === originalLinkIdentity?.space &&
            parsed?.scope === originalLinkIdentity?.scope &&
            JSON.stringify(parsed?.path) ===
              JSON.stringify(originalLinkIdentity?.path);
        });
        assertEquals(survivingOpaqueLink, originalRawLink);
        assertEquals(await piece.result.get(["historyCount"]), 2);

        // Clear-all is deliberately destructive at the membership layer: it
        // must remove both the readable keyed row and the opaque legacy link.
        await piece.result.set({}, ["clearHistory"]);
        await second.manager().runtime.idle();
        await second.manager().synced();
        const rawAfterClear = visitsCell.getRaw();
        assert(Array.isArray(rawAfterClear));
        assertEquals(rawAfterClear, []);
        assertEquals(await piece.result.get(["historyCount"]), 0);
        assertEquals(
          visitsFrom(await piece.result.get(["recentVisits"])),
          [],
        );
      } finally {
        cancelSecond?.();
        await second.dispose();
      }

      // Reopen as the opaque writer after host log + clear. The original
      // target document is unchanged even though clear-all removed its shared
      // membership link.
      const verifier = await initializePiecesController({
        apiUrl: server.url,
        identity: opaqueIdentity,
        spaceName,
      });
      try {
        assert(originalLinkIdentity);
        const opaqueTarget = verifier.manager().runtime.getCellFromLink<
          StoredVisit
        >(originalLinkIdentity as never);
        await opaqueTarget.sync();
        assertEquals(opaqueTarget.getRaw(), opaqueValue);
      } finally {
        await verifier.dispose();
      }
    } finally {
      await server.close();
    }
  });
});
