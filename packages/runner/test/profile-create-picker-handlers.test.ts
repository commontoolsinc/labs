import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { fromFileUrl } from "@std/path";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "profile-create-picker-handlers",
);
const space = signer.did();

const PROFILE_LINK_SCHEMA: JSONSchema = {
  type: "unknown",
  asCell: ["cell"],
};

const PROFILE_LINK_LIST_SCHEMA: JSONSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
};

type LinkCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
};

type LinkTarget = Pick<NormalizedFullLink, "space" | "scope" | "id" | "path">;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const linkCell = (value: unknown): LinkCell => {
  if (
    isRecord(value) &&
    typeof value.getAsNormalizedFullLink === "function"
  ) {
    return value as LinkCell;
  }
  throw new Error("Expected a link cell");
};

const linkList = (value: unknown): LinkCell[] => {
  if (!Array.isArray(value)) {
    throw new Error("Expected a link-cell list");
  }
  return value.map(linkCell);
};

const linkTarget = (link: NormalizedFullLink): LinkTarget => ({
  space: link.space,
  scope: link.scope,
  id: link.id,
  path: link.path,
});

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

const WRAPPER_SRC = [
  "import { action, pattern, Writable } from 'commonfabric';",
  "import { setDefaultProfile, setMruProfile } from './profile-create.tsx';",
  "",
  "type ProfileLinkFixture = {",
  "  name: string;",
  "  avatar: string;",
  "  bio: string;",
  "  elements: unknown[];",
  "};",
  "",
  "export default pattern(() => {",
  "  const defaultProfile = new Writable<ProfileLinkFixture | undefined>(undefined).for('defaultProfile');",
  "  const mru = new Writable<ProfileLinkFixture[]>([]).for('mru');",
  "  const unloaded = new Writable<ProfileLinkFixture | undefined>(undefined).for('unloaded');",
  "  const ada = new Writable<ProfileLinkFixture>({",
  "    name: 'Ada',",
  "    avatar: '',",
  "    bio: '',",
  "    elements: [],",
  "  }).for('ada');",
  "  const seedMru = action(() => {",
  "    mru.set([unloaded, ada] as never);",
  "  });",
  "  return {",
  "    defaultProfile,",
  "    mru,",
  "    unloaded,",
  "    ada,",
  "    chooseDefaultAda: setDefaultProfile({",
  "      defaultProfile: defaultProfile as never,",
  "      profile: ada as never,",
  "    }),",
  "    seedMru,",
  "    chooseAda: setMruProfile({",
  "      mru: mru as never,",
  "      profile: ada as never,",
  "    }),",
  "  };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const commit = (runtime: Runtime) => {
  const tx = runtime.edit();
  return {
    tx,
    commit: async () => {
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    },
  };
};

describe("profile-create picker handlers", () => {
  it("write selected profile links while preserving unloaded MRU entries", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const setup = commit(runtime);
      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
        tx: setup.tx,
      });
      const resultCell = runtime.getCell<Record<string, unknown>>(
        space,
        "profile-create picker handlers",
        undefined,
        setup.tx,
      );
      const result = runtime.run(setup.tx, compiled, {}, resultCell);
      runtime.prepareTxForCommit(setup.tx);
      await setup.commit();
      await result.pull();

      const defaultTx = commit(runtime);
      result.withTx(defaultTx.tx).key("chooseDefaultAda").send(undefined);
      await defaultTx.commit();

      const seedTx = commit(runtime);
      result.withTx(seedTx.tx).key("seedMru").send(undefined);
      await seedTx.commit();

      const mruTx = commit(runtime);
      result.withTx(mruTx.tx).key("chooseAda").send(undefined);
      await mruTx.commit();

      await result.pull();
      await runtime.idle();
      await result.pull();

      const adaLink = linkCell(
        result.key("ada").asSchema(PROFILE_LINK_SCHEMA).get(),
      ).getAsNormalizedFullLink();
      const unloadedLink = linkCell(
        result.key("unloaded").asSchema(PROFILE_LINK_SCHEMA).get(),
      ).getAsNormalizedFullLink();

      const defaultProfile = linkCell(
        result.key("defaultProfile").asSchema(PROFILE_LINK_SCHEMA).get(),
      );
      expect(linkTarget(defaultProfile.getAsNormalizedFullLink())).toEqual(
        linkTarget(adaLink),
      );

      const mru = linkList(
        result.key("mru").asSchema(PROFILE_LINK_LIST_SCHEMA).get(),
      );
      expect(mru.map((cell) => linkTarget(cell.getAsNormalizedFullLink())))
        .toEqual([
          linkTarget(adaLink),
          linkTarget(unloadedLink),
        ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
