import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("inspace-child-owner-seed");
const spaceA = signer.did(); // "home" — runs the parent, holds the list
const spaceB = (await Identity.fromPassphrase("owner seed child B")).did();

// Same two-manager shape as cross-space-value-read.test.ts: each session has
// its OWN per-space replicas, loopback-connected to one shared in-process
// memory server — the real browser/CLI session split. A single emulate
// manager's shared replicas would mask any "writer never committed X /
// reader never fetched X" gap.

// A creation handler starts a child in another space. An explicit lift reads
// its requested name, constructs the protected scalar, and returns a protected
// reference. A fresh session must read the seed from durable storage.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import {",
        "  Cell,",
        "  Cfc,",
        "  handler,",
        "  lift,",
        "  pattern,",
        "  RepresentsCurrentUser,",
        "  Stream,",
        "  Writable,",
        "  WriteAuthorizedBy,",
        "} from 'commonfabric';",
        "",
        "type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };",
        "",
        "type OwnerProtected<T, Binding> = RepresentsCurrentUser<",
        "  Cfc<",
        "    WriteAuthorizedBy<T, Binding>,",
        "    { ownerPrincipal: CurrentPrincipal }",
        "  >",
        ">;",
        "",
        "type SetNameEvent = { name?: string };",
        "",
        "const setName = handler<SetNameEvent, { name: Writable<string> }>(",
        "  (event, state) => {",
        "    state.name.set(event.name ?? '');",
        "  },",
        ");",
        "",
        "interface ChildOutput {",
        "  name: OwnerProtected<string, typeof setName>;",
        "  setName: Stream<SetNameEvent>;",
        "}",
        "",
        "const createName = lift<",
        "  { initialName?: string },",
        "  OwnerProtected<Cell<OwnerProtected<string, typeof setName>>, typeof setName>",
        ">(({ initialName }) =>",
        "  new Writable<OwnerProtected<string, typeof setName>>(initialName ?? '').for('name')",
        ");",
        "",
        "export const child = pattern<{ initialName?: string }, ChildOutput>(",
        "  ({ initialName }) => {",
        "    const name = createName({ initialName });",
        "    return {",
        "      name,",
        "      setName: setName({ name }),",
        "    };",
        "  },",
        ");",
        "",
        "const create = handler<",
        "  { name?: string },",
        "  { items: Writable<ChildOutput[]> }",
        ">((event, { items }) => {",
        `  items.push(child.inSpace("${spaceB}")({`,
        "    initialName: event.name ?? 'hi',",
        "  }) as ChildOutput);",
        "});",
        "",
        "export default pattern(() => {",
        "  const items = new Writable<ChildOutput[]>([]).for('items');",
        "  return { items, create: create({ items }) };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "inspace child owner seed parent";

const childLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("inSpace child owner-protected seed value (profile name)", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("lets a fresh session read the seeded owner-protected name", async () => {
    const runtimeErrors: unknown[] = [];
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
      errorHandlers: [(error) => runtimeErrors.push(error)],
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
      errorHandlers: [(error) => runtimeErrors.push(error)],
    });
    try {
      // Session 1: run the parent in space A; the handler creates the child
      // in space B with a seeded owner-protected `name` (profile creation).
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
      // The runtime's own commit paths (scheduler, editWithRetry) prepare;
      // an unprepared CFC-relevant tx is rejected wholesale at commit, so a
      // manual test tx must prepare too.
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit();
      expect(commit1.error).toBeUndefined();
      await r1.pull();

      // Fresh tx for the event send: the ifc-carrying schema makes send()
      // read CFC metadata through the cell's tx, and tx1 is already done.
      const tx2 = rt1.edit();
      r1.withTx(tx2).key("create").send({ name: "hi" });
      const commit2 = await tx2.commit();
      expect(commit2.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();

      await r1.pull();
      const links = r1.key("items").asSchema(childLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const childLink = links[0].getAsNormalizedFullLink();
      expect(childLink.space).toBe(spaceB);

      // The creating session itself sees the seed.
      expect(links[0].key("name").get()).toBe("hi");

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Session 2 reads the persisted terminal document through its own replicas.
      const childCell = rt2.getCellFromLink(childLink);
      await childCell.sync();
      const nameCell = childCell.key("name");
      await nameCell.sync();
      await nameCell.pull();
      expect(nameCell.get()).toBe("hi");

      // Starting the child reruns initialization against the existing seed.
      const started = await rt2.start(childCell);
      expect(started).toBe(true);
      await rt2.idle();
      await childCell.pull();
      const value = childCell.getAsQueryResult() as
        | { name?: string }
        | undefined;
      expect(value).toBeDefined();
      expect(value?.name).toBe("hi");
      expect(runtimeErrors).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
