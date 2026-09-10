import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const files = ["profile-home.tsx", "profile-create.tsx"].map((name) => ({
  name: `/${name}`,
  contents: Deno.readTextFileSync(
    new URL(`../../patterns/system/${name}`, import.meta.url),
  ),
}));

// This harness uses Home's exported reference contract while supplying a real
// profile from another space, including its populated identity assertions.
const forwardProgram = {
  main: "/forward.tsx",
  files: [...files, {
    name: "/forward.tsx",
    contents: `
      import { Cell, pattern } from "commonfabric";
      import type { ProfileReferenceValue, TrustedDefaultProfile } from "./profile-create.tsx";
      export default pattern<
        { profile: Cell<ProfileReferenceValue> },
        { defaultProfile: TrustedDefaultProfile }
      >(({ profile }) => ({ defaultProfile: profile as any }));
    `,
  }],
};

describe("Home published profile references", () => {
  it("forwards and resumes a populated profile through Home's reference contract", async () => {
    const signer = await Identity.fromPassphrase("home-published-profile");
    const space = signer.did();
    const profileSpace =
      (await Identity.fromPassphrase("published-profile-space")).did();
    const server = newSharedServer();
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const errors: unknown[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      cfcFlowLabels: "persist",
      errorHandlers: [(error) => errors.push(error)],
    });
    try {
      const setup = runtime.edit();
      const profilePattern = await runtime.patternManager.compilePattern({
        main: "/profile-home.tsx",
        files,
      }, {
        space: profileSpace,
        tx: setup,
      });
      const profile = runtime.run(
        setup,
        profilePattern,
        { initialName: "Ada" },
        runtime.getCell(profileSpace, "profile", undefined, setup),
      );
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit()).error).toBeUndefined();
      await profile.pull();

      const seed = runtime.edit();
      const assertion = runtime.getCell(
        profileSpace,
        "verified-github-login",
        undefined,
        seed,
      );
      writeSeedEnvelopeDoc(seed, profileSpace);
      seed.writeOrThrow({ ...assertion.getAsNormalizedFullLink(), path: [] }, {
        value: {
          type: "github.login",
          value: "ada",
          verifiedAt: "2026-07-15T20:00:00.000Z",
        },
        cfc: {
          version: 2,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["loom-verified-external-identity"] },
            }],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const publish = runtime.edit();
      profile.withTx(publish).key("publishVerifiedIdentities").send({
        identities: [assertion.withTx(publish)],
      });
      runtime.prepareTxForCommit(publish);
      expect((await publish.commit()).error).toBeUndefined();
      await runtime.idle();
      const identities = profile.key("verifiedIdentities").asSchema({
        type: "array",
        items: { asCell: ["cell"] },
      });
      await identities.pull();
      expect(identities.get()).toHaveLength(1);
      expect(identities.get()[0].equalLinks(assertion)).toBe(true);
      expect(errors).toEqual([]);

      const forward = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        forwardProgram,
        { space, tx: forward },
      );
      const result = runtime.run(forward, pattern, {
        profile: profile.withTx(forward),
      }, runtime.getCell(space, "home-reference", undefined, forward));
      runtime.prepareTxForCommit(forward);
      expect((await forward.commit()).error).toBeUndefined();
      await result.pull();
      expect(result.key("defaultProfile").key("name").get()).toBe("Ada");
      const resultLink = result.getAsNormalizedFullLink();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      await runtime.dispose();

      const coldManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: coldManager,
        cfcFlowLabels: "persist",
        errorHandlers: [(error) => errors.push(error)],
      });
      try {
        const resumed = cold.getCellFromLink(resultLink);
        await resumed.sync();
        expect(await cold.start(resumed)).toBe(true);
        await resumed.pull();
        await cold.idle();
        const selected = resumed.key("defaultProfile").resolveAsCell();
        expect(selected.getAsNormalizedFullLink().space).toBe(profileSpace);
        expect(await selected.key("name").pull()).toBe("Ada");
        expect(errors).toEqual([]);
      } finally {
        await cold.dispose();
        await coldManager.close();
      }
    } finally {
      await runtime.dispose();
      await manager.close();
      await server.close();
    }
  });
});
