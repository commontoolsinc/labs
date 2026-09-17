import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
} from "../src/index.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

function profileCreatorProgram(): RuntimeProgram {
  return {
    main: "/api/patterns/system/profile-create.tsx",
    files: ["profile-create.tsx", "profile-home.tsx"].map((name) => ({
      name: `/api/patterns/system/${name}`,
      contents: Deno.readTextFileSync(
        new URL(`../../patterns/system/${name}`, import.meta.url),
      ),
    })),
  };
}

describe("profile-cold-creation-source", () => {
  it("creates nested tracked children when a stored graph first starts", async () => {
    const signer = await Identity.fromPassphrase("cold static source creation");
    const childSpace = (await signer.derive("child")).did();
    const grandchildSpace = (await signer.derive("grandchild")).did();
    const program: RuntimeProgram = {
      main: "/parent.tsx",
      files: [{
        name: "/parent.tsx",
        contents: `
          import { pattern } from "commonfabric";
          import Child from "./child.tsx";
          export default pattern(() => ({
            child: Child.inSpace("${childSpace}")({}, { sourceOrigin: "system:child.tsx" }),
          }));
        `,
      }, {
        name: "/child.tsx",
        contents: `
          import { pattern } from "commonfabric";
          import Grandchild from "./grandchild.tsx";
          export default pattern<Record<string, never>>(() => ({
            grandchild: Grandchild.inSpace("${grandchildSpace}")({}, { sourceOrigin: "system:grandchild.tsx" }),
          }));
        `,
      }, {
        name: "/grandchild.tsx",
        contents: `
          import { pattern, Writable } from "commonfabric";
          export default pattern<Record<string, never>>(() => ({ value: new Writable("saved").for("value") }));
        `,
      }],
    };
    const server = newSharedServer();
    const firstManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const secondManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const first = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: firstManager,
    });
    const second = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: secondManager,
    });
    try {
      const tx = first.edit();
      const pattern = await first.patternManager.compilePattern(program, {
        space: signer.did(),
        tx,
      });
      const result = first.getCell(signer.did(), "static-parent");
      first.setup(tx, pattern, {}, result);
      first.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await first.patternManager.flushCompileCacheWrites();
      using _replicate = stub(second.patternManager, "replicatePatternToSpace");
      const opened = second.getCellFromLink(result.getAsNormalizedFullLink());
      expect(await second.start(opened)).toBe(true);
      await opened.pull();
      await second.scheduler.idleWithPendingCommits();
      const child = opened.key("child").asSchema<Cell<unknown>>({
        type: "unknown",
        asCell: ["cell"],
      }).get().withTx();
      await child.pull();
      const grandchild = child.key("grandchild").asSchema<Cell<unknown>>({
        type: "unknown",
        asCell: ["cell"],
      }).get().withTx();
      for (
        const [piece, expectedOrigin] of [[child, "system:child.tsx"], [
          grandchild,
          "system:grandchild.tsx",
        ]] as const
      ) {
        expect(getPatternSource(piece)).toBe(expectedOrigin);
        expect(
          getPieceSourceRevisions(piece).map((revision) => revision.operation),
        ).toEqual(["create"]);
        expect(
          await first.patternManager.getPatternSourceProgramByIdentity(
            getPatternIdentityRef(piece)!.identity,
            piece.space,
          ),
        ).toBeDefined();
      }
    } finally {
      await first.patternManager.flushCompileCacheWrites();
      await second.patternManager.flushCompileCacheWrites();
      await second.dispose();
      await first.dispose();
      await secondManager.close();
      await firstManager.close();
      await server.close();
    }
  });

  for (const refuseSource of [false, true]) {
    it(
      refuseSource
        ? "leaves the profile list unchanged when source preparation fails"
        : "loads source before publishing a profile from a stored creator",
      async () => {
        const program = profileCreatorProgram();
        const signer = await Identity.fromPassphrase("cold profile creation");
        const server = newSharedServer();
        const firstManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const secondManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const fetch: RuntimeFetch = (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const contents = program.files.find((file) =>
            file.name === url.pathname
          )
            ?.contents;
          return Promise.resolve(
            contents === undefined
              ? new Response("not found", { status: 404 })
              : new Response(contents),
          );
        };
        const first = new Runtime({
          apiUrl: new URL("https://profile.test"),
          storageManager: firstManager,
          fetch,
        });
        const second = new Runtime({
          apiUrl: new URL("https://profile.test"),
          storageManager: secondManager,
          fetch,
        });
        const errors: unknown[] = [];
        const preparing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        second.scheduler.onError((error) => {
          errors.push(error);
          preparing.reject(error);
        });
        try {
          const tx = first.edit();
          const creator = await first.patternManager.compilePattern(program, {
            space: signer.did(),
            tx,
          });
          const profiles = first.getCell<unknown[]>(
            signer.did(),
            "profiles",
            undefined,
            tx,
          );
          profiles.set([]);
          const result = first.getCell(signer.did(), "creator", undefined, tx);
          first.runner.run(tx, creator, { profiles }, result);
          first.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
          await result.withTx().pull();
          await first.patternManager.flushCompileCacheWrites();

          const opened = second.getCellFromLink(
            result.getAsNormalizedFullLink(),
          );
          expect(await second.start(opened)).toBe(true);
          await opened.pull();
          const prepare = second.patternManager.preparePatternSource.bind(
            second.patternManager,
          );
          using _prepare = stub(
            second.patternManager,
            "preparePatternSource",
            async (...args) => {
              preparing.resolve();
              await release.promise;
              if (refuseSource) throw new Error("source preparation refused");
              return prepare(...args);
            },
          );
          // Retained source must commit with the profile, independently of the
          // best-effort compiled-cache replication.
          using _replicate = stub(
            second.patternManager,
            "replicatePatternToSpace",
          );
          const eventTx = second.edit();
          opened.withTx(eventTx).key("createProfile").send({ name: "Ada" });
          second.prepareTxForCommit(eventTx);
          expect((await eventTx.commit()).error).toBeUndefined();
          await preparing.promise;
          const observed = first.getCellFromLink(
            profiles.getAsNormalizedFullLink(),
          )
            .asSchema<Cell<unknown>[]>({
              type: "array",
              items: { type: "unknown", asCell: ["cell"] },
            });
          await observed.pull();
          expect(observed.get()).toEqual([]);
          release.resolve();
          await second.scheduler.idleWithPendingCommits();
          await observed.pull();
          if (refuseSource) {
            expect(errors).toHaveLength(1);
            expect(errors[0]).toBeInstanceOf(Error);
            expect((errors[0] as Error).message).toBe(
              "source preparation refused",
            );
            expect(observed.get()).toEqual([]);
            return;
          }
          expect(errors).toEqual([]);
          expect(observed.get()).toHaveLength(1);
          const profile = observed.get()[0].withTx();
          await profile.sync();
          expect(getPatternSource(profile)).toBe(
            "system:system/profile-home.tsx",
          );
          expect(
            getPieceSourceRevisions(profile).map((revision) =>
              revision.operation
            ),
          )
            .toEqual(["create"]);
          expect(
            await first.patternManager.getPatternSourceProgramByIdentity(
              getPatternIdentityRef(profile)!.identity,
              profile.space,
            ),
          ).toBeDefined();
          expect(await first.start(profile)).toBe(true);
          await profile.pull();
          expect(profile.key("name").asSchema<string>({ type: "string" }).get())
            .toBe("Ada");
        } finally {
          release.resolve();
          await first.patternManager.flushCompileCacheWrites();
          await second.patternManager.flushCompileCacheWrites();
          await second.dispose();
          await first.dispose();
          await secondManager.close();
          await firstManager.close();
          await server.close();
        }
      },
    );
  }
});
