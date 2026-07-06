import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { fromFileUrl } from "@std/path";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// CT-1845: "Set default" in the profile picker.
//
// Clicking "Set default" fires `setDefaultProfile`, whose body writes the
// chosen profile into the home's single owner-protected `defaultProfile` slot
// (`TrustedDefaultProfile` = `Cell<ProfileHomeOutput>`, writeAuthorizedBy:
// setDefaultProfile). In the browser this failed permanently and silently:
//   CFC enforcement rejected commit: relevant transaction was not prepared:
//   writeAuthorizedBy failed at /avatar
//
// Root cause: `TrustedDefaultProfile`'s declared schema is a link to
// ProfileHomeOutput, but CFC resolves that `$ref` and walks ProfileHomeOutput's
// OWN fields — name/avatar/bio/elements, each owner-protected with its own
// `writeAuthorizedBy: set…`. CFC enforces a nested field only when the WRITTEN
// VALUE carries a concrete value there. A pre-fix `defaultProfile.set(profile)`
// where `profile` is a *loaded* Cell inlines the resolved profile value (with a
// concrete `/avatar`), so the nested `/avatar` claim is enforced against the
// wrong writer (setDefaultProfile ≠ setAvatar) and the commit is rejected. The
// fix writes the serialized LINK sigil (`profile.getAsLink()`), which the
// `.set()` value walk passes through verbatim — a pure reference with no
// inlined sub-fields, so no nested claim is ever enforced.
//
// This test drives the REAL shipped patterns in a real cross-space runtime
// (profile-create.tsx handlers + profile-home.tsx). It stands up TWO profiles
// in their own inSpace spaces, loads them, then exercises the fixed
// `setDefaultProfile` through BOTH the fixed-index and the exact picker `.map`
// binding, asserting each commits cleanly and stores a PURE LINK (never an
// inlined object). See the note at the bottom on why the browser-only inline
// fault is not directly reproducible in the headless runner.
const signer = await Identity.fromPassphrase("profile-set-default-cfc");
const spaceA = signer.did();

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }
  private sharedServer!: MemoryV2Server.Server;
  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// A wrapper owning the home `profiles`, `defaultProfile`, and `mru` cells,
// mirroring home.tsx's profile model. The `defaultProfile`/`mru` slots carry
// the picker's owner-protected contracts through the pattern OUTPUT schema
// (TrustedDefaultProfile / TrustedProfileMru), so the CFC write-policy check on
// `setDefaultProfile` / `setMruProfile` is exercised exactly as in home. It
// embeds ProfileCreate for the (cross-space) create stream and exposes
// setDefaultProfile / setMruProfile as streams whose `profile` state is bound
// per-row — both by fixed index and via the exact picker `.map` — mirroring the
// picker's `profiles.map((p) => setDefaultProfile({ …, profile: p }))`.
const WRAPPER_SRC = [
  "import ProfileCreate, {",
  "  setDefaultProfile,",
  "  setMruProfile,",
  "} from './profile-create.tsx';",
  "import type {",
  "  TrustedDefaultProfile,",
  "  TrustedProfileMru,",
  "} from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "type WrapperOutput = {",
  "  profiles: Writable<ProfileHomeOutput[]>;",
  "  defaultProfile: TrustedDefaultProfile;",
  "  mru: TrustedProfileMru;",
  "  createProfile: unknown;",
  "  setDefault1: unknown;",
  "  setDefaultMapped: unknown[];",
  "  setMru0: unknown;",
  "};",
  "",
  "export default pattern<Record<never, never>, WrapperOutput>(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const defaultProfile = new Writable<ProfileHomeOutput | undefined>(",
  "    undefined,",
  "  ).for('defaultProfile');",
  "  const mru = new Writable<ProfileHomeOutput[]>([]).for('mru');",
  "  const created = ProfileCreate({ profiles });",
  "  return {",
  "    profiles: profiles as any,",
  "    defaultProfile: defaultProfile as any,",
  "    mru: mru as any,",
  "    createProfile: created.createProfile,",
  "    setDefault1: setDefaultProfile({",
  "      defaultProfile: defaultProfile as any,",
  "      profile: profiles.key(1) as any,",
  "    }),",
  // The EXACT picker binding: `profiles.map((p) => setDefaultProfile({ …,
  // profile: p }))`. `p` is the per-row item the picker passes as `profile`
  // handler state — the headless mirror of the browser's UI binding.
  "    setDefaultMapped: profiles.map((p: any) =>",
  "      setDefaultProfile({",
  "        defaultProfile: defaultProfile as any,",
  "        profile: p,",
  "      })",
  "    ) as any,",
  "    setMru0: setMruProfile({",
  "      mru: mru as any,",
  "      profile: profiles.key(0) as any,",
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

const RESULT_CAUSE = "profile set default cfc";

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

const profileLinkSchema = {
  type: "unknown",
  asCell: ["cell"],
  // deno-lint-ignore no-explicit-any
} as any;

// A single serialized `link@1` (or `alias@1`) sigil: { "/": { "link@1": ... } }.
// A pure link has exactly the `/` key and NO sibling data fields (no inlined
// avatar/name/...). This is the property the CT-1845 fix guarantees for the
// defaultProfile slot: without it, a loaded profile inlines and CFC rejects the
// commit at the nested `/avatar` owner-protected sub-field.
const isPureLinkSigil = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "/") return false;
  const inner = (value as Record<string, unknown>)["/"];
  if (typeof inner !== "object" || inner === null) return false;
  return Object.keys(inner as Record<string, unknown>).some((k) =>
    k === "link@1" || k === "alias@1"
  );
};

describe("profile set-default CFC (REAL patterns, cross-space) — CT-1845", () => {
  let server: MemoryV2Server.Server;
  let managerA: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = SharedServerStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await managerA?.close();
    await server?.close();
  });

  it("Set default commits cleanly and stores a pure link (fixed + picker binding)", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    try {
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceA,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit();
      expect(commit1.error).toBeUndefined();
      await r1.pull();

      // Create two profiles (each in its own inSpace space).
      for (const name of ["AdaTest", "GraceTest"]) {
        const tx = rt1.edit();
        r1.withTx(tx).key("createProfile").send({ name });
        const commit = await tx.commit();
        expect(commit.error).toBeUndefined();
        await r1.pull();
        await rt1.idle();
        await r1.pull();
      }

      const profiles = r1.key("profiles").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(profiles.length).toBe(2);
      // Each profile lives in its OWN space (inSpace), not the home space.
      expect(profiles[1].getAsNormalizedFullLink().space).not.toBe(spaceA);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();

      // Load each profile's OWN (inSpace) cell — the browser condition (the
      // picker renders each row's name/avatar, materializing the profile's
      // cross-space value locally before "Set default" fires).
      for (const p of profiles) {
        const cell = rt1.getCellFromLink(p.getAsNormalizedFullLink());
        await cell.sync();
        await rt1.start(cell);
        await rt1.idle();
        await cell.pull();
      }
      await rt1.idle();

      const profileSpaces = new Set(
        profiles.map((p) => p.getAsNormalizedFullLink().space),
      );

      // Baseline: MRU write works (the KNOWN-GOOD picker write) — appends a link
      // into an array-valued owner-protected slot. `profile` is bound state
      // (profiles.key(0)); the event is empty, as in the picker.
      const mruTx = rt1.edit();
      r1.withTx(mruTx).key("setMru0").send({});
      const mruCommit = await mruTx.commit();
      expect(mruCommit.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await r1.pull();
      const mruList = r1.key("mru").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(mruList.length).toBe(1);

      // (1) Fixed-index binding: setDefaultProfile writes the serialized profile
      // LINK — not the inlined value — so no nested `/avatar` sub-field is
      // written and CFC accepts the commit.
      const defTx = rt1.edit();
      r1.withTx(defTx).key("setDefault1").send({});
      const defCommit = await defTx.commit();
      expect(defCommit.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await r1.pull();

      const def = r1.key("defaultProfile").asSchema(profileLinkSchema).get();
      expect(def).toBeDefined();
      // Identity is by SPACE (CT-1842): the picker stores a profile under a
      // different entity id than the `profiles` list, so match on the space DID.
      expect(
        // deno-lint-ignore no-explicit-any
        profileSpaces.has((def as any).getAsNormalizedFullLink().space),
      ).toBe(true);
      // The stored value is a PURE LINK — the property the fix guarantees.
      expect(isPureLinkSigil(r1.key("defaultProfile").getRaw())).toBe(true);

      // (2) The EXACT picker `.map` binding — the browser gesture, with each
      // profile's own space loaded. Must commit cleanly and store a pure link.
      const mappedTx = rt1.edit();
      r1.key("setDefaultMapped").key(0).withTx(mappedTx).send({});
      const mappedCommit = await mappedTx.commit();
      expect(mappedCommit.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await r1.pull();

      const def2 = r1.key("defaultProfile").asSchema(profileLinkSchema).get();
      expect(def2).toBeDefined();
      expect(
        // deno-lint-ignore no-explicit-any
        profileSpaces.has((def2 as any).getAsNormalizedFullLink().space),
      ).toBe(true);
      expect(isPureLinkSigil(r1.key("defaultProfile").getRaw())).toBe(true);
    } finally {
      await rt1.dispose();
    }
  });
});

// NOTE on reproducibility. The browser-only symptom — CFC rejecting the commit
// with "writeAuthorizedBy failed at /avatar" — arises when
// `defaultProfile.set(profile)` INLINES the resolved profile value (with a
// concrete `/avatar`) into the single owner-protected slot. That inlining
// happens in the browser because the picker's UI render (`<cf-cell-link>` /
// `<cf-profile-badge>` on each row) materializes the profile value into the
// picker's own reactive graph, so `.set()` of that live proxy serializes the
// value rather than a link. In the headless runner the profile value is loaded
// into the runtime (above) but NOT threaded through a UI render into the
// pattern's reactive graph, so `.set(<Cell>)` consistently serializes a link
// and the pre-fix handler does not fault here. This test therefore GUARDS the
// fix's invariant directly — the write stores a pure link (never an inlined
// object) — which is the exact property that makes the nested `/avatar` claim
// inapplicable and the commit succeed. The inlined-write rejection itself is
// verified at the CFC layer by the direct-value repro in
// `packages/runner/test/cfc-boundary.test.ts` semantics (owner-protected nested
// sub-field enforcement), and manually in-browser.
