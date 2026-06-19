/**
 * Regression test: scalar `$value` UI input is a precondition-free
 * last-write-wins leaf write (supersedes the #4126 cellset-silent-rollback
 * queue work).
 *
 * A scalar `$value`/`$checked` edit is a full leaf overwrite. `handleCellSet`
 * marks its transaction as a blind-leaf-write (around the `set` only), so the
 * write carries no concurrency precondition. Under concurrent same-user edits it
 * therefore no longer hits the "stale confirmed read" conflict that rolled the
 * write back and silently dropped a profile/draft edit — the cfc-group-chat-demo
 * "Name not set" flake. Structured (array/object) writes are NOT marked blind —
 * they may be read-modify-write (CellHandle.push, multi-select, list edits) — and
 * retain compare-and-set so concurrent list mutations still cannot lose updates.
 *
 * profileDraft is PerUser, so two sessions of the same identity share the doc
 * (≈ two browser tabs of one user): the own-write race.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "cfc-group-chat-demo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");
const DRAFT: (string | number)[] = ["profileDraft"];

// Trusted surface/action for the profile save (inlined from
// cfc-group-chat-demo/trusted.tsx, as the multi-runtime demo test does).
const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";

const isConflict = (error?: { name?: string; message?: string }): boolean =>
  error?.name === "ConflictError" ||
  (error?.message?.includes("stale confirmed read") ?? false);

describe("cellset last-write-wins for scalar $value (own-write race)", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    const aliceId = await Identity.fromPassphrase("cellset-lww alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceId },
        // Same user as alice, separate session ≈ second browser tab.
        { label: "alice-tab2", identity: aliceId },
      ],
    });
    alice = harness.session("alice");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("concurrent same-user scalar sets never conflict", async () => {
    for (let i = 0; i < 8; i++) {
      await harness.settle(); // converge both sessions to one baseline seq
      const [a, b] = await Promise.all([
        alice.set([...DRAFT], `alice-${i}`, { idle: false }),
        aliceTab2.set([...DRAFT], `tab2-${i}`, { idle: false }),
      ]);
      assert(
        a.ok,
        `alice scalar set ${i} should not conflict: ${JSON.stringify(a.error)}`,
      );
      assert(
        b.ok,
        `tab2 scalar set ${i} should not conflict: ${JSON.stringify(b.error)}`,
      );
    }
  });

  it("structured (non-scalar) writes retain compare-and-set", async () => {
    // The narrowing that keeps read-modify-write safe: an array/object value is
    // not a blind leaf write, so concurrent same-user structured writes still
    // hit the own-write-race conflict (compare-and-set), preventing lost updates.
    let conflicts = 0;
    for (let i = 0; i < 8; i++) {
      await harness.settle();
      const [a, b] = await Promise.all([
        alice.set([...DRAFT], [`alice-${i}`], { idle: false }),
        aliceTab2.set([...DRAFT], [`tab2-${i}`], { idle: false }),
      ]);
      if (isConflict(a.error) || isConflict(b.error)) conflicts++;
    }
    assert(
      conflicts > 0,
      "concurrent structured writes must still hit compare-and-set conflicts " +
        "(blind-leaf-write must not apply to non-scalar values)",
    );
  });

  it("end-to-end: a typed name survives the own-write race through save", async () => {
    // The original cfc-group-chat-demo "Name not set" flake, end to end: a user
    // types a profile name (a scalar `$value` write to the PerUser draft), then
    // saves. The save handler (commitTrustedProfileSave) reads draftText(nameDraft).
    // Pre-fix, the draft `$value` write loses the own-write race, is rejected and
    // rolled back to its prior (empty) value, so the save reads the wrong/empty
    // draft and the profile name is not the one the user typed. With the fix the
    // scalar write is precondition-free, lands, and the save reads it.
    for (let i = 0; i < 5; i++) {
      await harness.settle();
      // Another concurrent write bumps the shared PerUser draft's seq…
      await aliceTab2.set([...DRAFT], `tab2-${i}`, { idle: false });
      // …so alice's later typed name commits against a stale baseline.
      const typed = `alice-typed-${i}`;
      await alice.set([...DRAFT], typed, { idle: false });
      // Save the profile via the trusted action (reads draftText(nameDraft)).
      await alice.send("saveProfile", {}, {
        surface: PROFILE_SURFACE,
        action: SAVE_PROFILE_ACTION,
      });
      await harness.settle();
      assertEquals(
        await alice.read(["currentProfileName"]),
        typed,
        `the name alice typed must be the saved profile name (iter ${i})`,
      );
    }
  });
});
