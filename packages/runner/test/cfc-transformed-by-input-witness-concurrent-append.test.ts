import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { type Cell, cellTx } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// An append commits as a tail-relative operation, and the server puts it at
// the list's live tail, while the label envelope the appending transaction
// computed describes the list as it saw it. Two appends from sessions that
// saw the same list would land at two positions with the envelope written
// last describing one of them at the position the other took, so a labeled
// append whose list moved under it conflicts and is re-derived against the
// live list (`SpaceReplica.#commitReadActivities`), and its stamp lands
// beside its own element. A stored envelope from before that held can still
// stamp a slot beside another writer's reference, so a slot's stamp counts
// toward a follower's input witness only where the slot's link entry names
// the reference the slot holds, and a stamp describing another reference
// witnesses nothing.

const signer = await Identity.fromPassphrase("cfc-witness-concurrent-append");
const space = signer.did();
const ROOM = cfcAtom.space(space);

const verified = (
  moduleIdentity: string,
  symbol: string,
): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity,
  symbol,
  bindingPath: [symbol],
});

const SUBMIT = verified("module:conclave", "submit");
const COMMIT = verified("module:conclave", "commit");
const ATTACKER = verified("module:attacker", "plant");

const runtimeOver = (storageManager: EmulatedStorageManager) =>
  new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });

/** Seeds a labeled document each writer reads, and the empty list. */
const seed = async (runtime: Runtime): Promise<void> => {
  const tx = runtime.edit();
  const id = runtime.getCell(space, "secret", undefined, tx)
    .getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(tx, space);
  seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
    value: { note: "s" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: [], label: { confidentiality: [ROOM] } }],
      },
    },
  });
  runtime.getCell(space, "briefs", undefined, tx).set([]);
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

/** Loads the list and the labeled document at the runtime's current basis. */
const load = async (runtime: Runtime): Promise<void> => {
  for (const name of ["briefs", "secret"]) {
    const cell = runtime.getCell(space, name);
    await cell.sync();
    await cell.pull();
  }
};

/**
 * Appends one brief as `identity`, in a frame of its own, the way a handler
 * run does: an append whose list moved under it is refused, and is re-run
 * against the live list. The server's fan-out is manual here, so the re-run
 * drives it itself, where `editWithRetry` would wait to be caught up.
 */
const push = async (
  server: MemoryV2Server.Server,
  runtime: Runtime,
  identity: ImplementationIdentity,
  vote: string,
): Promise<void> => {
  const attempt = async () => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, identity);
    runtime.getCell(space, "secret", undefined, tx).getRaw();
    const frame = pushFrame({
      generatedIdCounter: 0,
      cause: `${identity.kind === "verified" ? identity.symbol : ""}-${vote}`,
    });
    try {
      runtime.getCell<unknown[]>(space, "briefs", undefined, tx)
        .push({ vote } as never);
    } finally {
      popFrame(frame);
    }
    tx.prepareCfc();
    return (await tx.commit({ holdSyncedUntilCovered: false }).verdict).error;
  };
  let error = await attempt();
  if (error?.name === "ConflictError") {
    await server.flushSessions();
    await load(runtime);
    error = await attempt();
  }
  expect(error).toBeUndefined();
  await runtime.storageManager.synced();
};

/**
 * The stored envelope of the list of briefs: at each slot, the reference the
 * writer's value stamp names and the writer it names.
 */
const storedSlotStamps = async (
  server: MemoryV2Server.Server,
): Promise<{ slot: string; names: string; writer: string }[]> => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = runtimeOver(storageManager);
  try {
    await load(runtime);
    const tx = runtime.edit();
    const briefs = runtime.getCell<unknown[]>(space, "briefs", undefined, tx);
    const held = (briefs.getRaw() as unknown[]).map((link) =>
      parseLink(link, briefs)!.id
    );
    const metadata = readStoredCfcMetadata(
      tx,
      briefs.getAsNormalizedFullLink(),
    );
    tx.abort();
    return (metadata?.labelMap.entries ?? []).flatMap((entry) => {
      if (
        entry.observes !== "value" || entry.path.length !== 1 ||
        !/^\d+$/.test(entry.path[0])
      ) return [];
      const integrity = entry.label.integrity ?? [];
      const names = integrity.find((atom) =>
        (atom as { type?: unknown }).type === CFC_ATOM_TYPE.LinkReference
      ) as { source: { id: string } } | undefined;
      const writer = integrity.find((atom) =>
        (atom as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy
      ) as { identity?: { symbol?: string } } | undefined;
      const slot = entry.path[0];
      return [{
        slot,
        names: names?.source.id === held[Number(slot)] ? "held" : "other",
        writer: writer?.identity?.symbol ?? "",
      }];
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Runs `step` as the attacker's code, in a frame of its own. */
const asAttacker = async (
  runtime: Runtime,
  step: (briefs: Cell<unknown[]>) => void,
): Promise<void> => {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, ATTACKER);
  runtime.getCell(space, "secret", undefined, tx).getRaw();
  const frame = pushFrame({ generatedIdCounter: 0, cause: "attacker" });
  try {
    step(runtime.getCell<unknown[]>(space, "briefs", undefined, tx));
  } finally {
    popFrame(frame);
  }
  tx.prepareCfc();
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

/**
 * Whether the commit step, reading every brief through its reference, mints
 * the witness naming the submit step.
 */
const commitWitnessesSubmit = async (
  server: MemoryV2Server.Server,
  expectedVotes: string[],
): Promise<boolean> => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = runtimeOver(storageManager);
  try {
    await load(runtime);
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, COMMIT);
    const briefs = runtime.getCell<{ vote: string }[]>(
      space,
      "briefs",
      undefined,
      tx,
    ).get();
    const votes = (briefs ?? []).map((brief) => brief.vote);
    expect(votes).toEqual(expectedVotes);
    runtime.getCell(space, "committed", undefined, tx).set({ votes });
    tx.prepareCfc();
    expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
    const readTx = runtime.edit();
    const metadata = readStoredCfcMetadata(
      readTx,
      runtime.getCell(space, "committed", undefined, readTx)
        .getAsNormalizedFullLink(),
    );
    readTx.abort();
    return (metadata?.labelMap.entries ?? []).some((entry) =>
      (entry.label.integrity ?? []).some((atom) => {
        const witness = (atom as { inputWitness?: { identity?: unknown } })
          .inputWitness;
        return (atom as { type?: unknown }).type ===
            CFC_ATOM_TYPE.TransformedBy &&
          witness !== undefined &&
          (witness.identity as { symbol?: unknown })?.symbol ===
            "submit";
      })
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * Seeds two submitted briefs and a list of references to them whose slot
 * stamps name the submit step, the stamp at the second slot describing the
 * reference `described` names while the slot holds the one `held` names: the
 * label state a stale envelope leaves when an append lands elsewhere.
 */
const seedListOfBriefs = async (
  runtime: Runtime,
  held: "first" | "second",
  described: "first" | "second" | "legacy",
): Promise<void> => {
  const tx = runtime.edit();
  writeSeedEnvelopeDoc(tx, space);
  const stamp = (reference?: string) => ({
    confidentiality: [ROOM],
    integrity: [
      { type: CFC_ATOM_TYPE.TransformedBy, identity: SUBMIT },
      ...(reference === undefined ? [] : [{
        type: CFC_ATOM_TYPE.LinkReference,
        source: { space, id: reference, path: [] },
        target: { space, id: briefsId, path: [] },
      }]),
    ],
  });
  const idOf = (name: string) =>
    runtime.getCell(space, name, undefined, tx).getAsNormalizedFullLink().id;
  const briefsId = idOf("briefs");
  const briefs = { first: idOf("first-brief"), second: idOf("second-brief") };
  for (const [name, vote] of [["first", "reject"], ["second", "approve"]]) {
    seedStoredEnvelope(tx, {
      space,
      scope: "space",
      id: briefs[name as "first" | "second"],
      path: [],
    }, {
      value: { vote },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: stamp(),
            origin: "derived",
            observes: "value",
          }],
        },
      },
    } as never);
  }
  const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });
  seedStoredEnvelope(tx, { space, scope: "space", id: briefsId, path: [] }, {
    value: [link(briefs.first), link(briefs[held])],
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["0"],
            label: stamp(briefs.first),
            origin: "derived",
            observes: "value",
          },
          described === "legacy"
            // A stamp from before entries were tagged: no origin, no
            // observation class, and no reference named beside the writer.
            ? { path: ["1"], label: stamp() }
            : {
              path: ["1"],
              label: stamp(briefs[described]),
              origin: "derived",
              observes: "value",
            },
        ],
      },
    },
  } as never);
  expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
    .toBeUndefined();
  await runtime.storageManager.synced();
};

describe("input witnesses over appends made concurrently", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    managers = [];
    runtimes = [];
  });
  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const session = () => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = runtimeOver(manager);
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  it("witnesses the submit step over appends made in turn", async () => {
    const first = session();
    await seed(first);
    await push(server, first, SUBMIT, "reject");
    await push(server, first, SUBMIT, "approve");
    expect(await commitWitnessesSubmit(server, ["reject", "approve"])).toBe(
      true,
    );
  });

  it("lands a labeled append's stamp beside its own element when the list moved under it", async () => {
    // The submit step appends from the list as it was before the attacker
    // appended. Its commit is re-derived against the live list, so its stamp
    // sits at the position the store gave its element, and the attacker's
    // stamp at the position before it is left standing.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await load(stale);
    await push(server, attacker, ATTACKER, "approve");
    await push(server, stale, SUBMIT, "reject");
    expect(await storedSlotStamps(server)).toEqual([
      { slot: "0", names: "held", writer: "plant" },
      { slot: "1", names: "held", writer: "submit" },
    ]);
  });

  it("withholds the witness where a copied reference's slot was stamped by its copier", async () => {
    // The attacker appends a copy of the submitted brief's reference while the
    // submit step appends from the list as it was, then removes the submit
    // step's brief. The slot holding the copy carries the attacker's stamp,
    // which names no step the follower endorses.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await push(server, attacker, SUBMIT, "reject");
    await load(stale);
    await asAttacker(attacker, (briefs) => {
      const stored = briefs.getRaw() as unknown[];
      briefs.push(stored[0] as never);
    });
    await push(server, stale, SUBMIT, "approve");
    // The attacker's later code, in a session that sees both appends.
    const later = session();
    await load(later);
    await asAttacker(later, (briefs) => {
      const stored = briefs.getRaw() as unknown[];
      expect(stored).toHaveLength(3);
      const submitted = parseLink(stored[2], briefs)!;
      briefs.removeByValue(
        later.getCellFromLink(submitted, undefined, cellTx(briefs)) as never,
      );
    });
    expect(await commitWitnessesSubmit(server, ["reject", "reject"])).toBe(
      false,
    );
  });

  it("witnesses the submit step through slot stamps that name their references", async () => {
    await seedListOfBriefs(session(), "second", "second");
    expect(await commitWitnessesSubmit(server, ["reject", "approve"])).toBe(
      true,
    );
  });

  it("withholds the witness through a slot whose stamp names another reference", async () => {
    // The second slot holds a copy of the first brief's reference, and its
    // stamp names the second brief: the stamp does not describe the slot.
    await seedListOfBriefs(session(), "first", "second");
    expect(await commitWitnessesSubmit(server, ["reject", "reject"])).toBe(
      false,
    );
  });

  it("withholds the witness through a slot whose untagged stamp names no reference", async () => {
    // The second slot holds a copy of the first brief's reference, and its
    // stamp, one written before entries were tagged, names the submit step
    // but no reference, so it cannot say which pointer it describes.
    await seedListOfBriefs(session(), "first", "legacy");
    expect(await commitWitnessesSubmit(server, ["reject", "reject"])).toBe(
      false,
    );
  });

  it("withholds the witness where a concurrent append put another writer's element among the submitted ones", async () => {
    // The submit step's session loads the list before the attacker appends,
    // so its append is made against the list as it was and is re-run against
    // the live one. The commit step then reads an element the attacker wrote,
    // whose stamp names no step it endorses.
    const attacker = session();
    const stale = session();
    await seed(attacker);
    await load(stale);
    await push(server, attacker, ATTACKER, "approve");
    await push(server, stale, SUBMIT, "reject");
    expect(await commitWitnessesSubmit(server, ["approve", "reject"])).toBe(
      false,
    );
  });
});
