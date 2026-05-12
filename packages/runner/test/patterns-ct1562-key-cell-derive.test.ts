// CT-1562: `const rooms = conversation.rooms` followed by
// `rooms.map(...).join("\n")` in a non-JSX value-site expression crashes
// at runtime with `TypeError: rooms.map is not a function` when the
// schema generated for `rooms` includes the `Default<[]>` `anyOf` split
// (`{ type: "array", items: false }` vs `{ items: { $ref } }`).
//
// Root cause: in the schema traversal, BOTH `anyOf` branches "match" a
// populated array because `canBranchMatch` doesn't honor `items: false`;
// then `mergeAnyOfMatches` runs `Object.assign({}, …branches)` because
// arrays satisfy `isRecord`. The result is `{ "0": room1, "1": room2 }`
// — a plain object that drops array-ness, and `.map` is undefined.
//
// See packages/ts-transformers/docs/ct1562-investigation.md for the
// full evidence (including a probe deployed via `cf piece` that observed
// `{ isArray: false, ctor: "Object", keys: ["0","1"], hasMap: false }`
// inside the derive callback).
//
// This test is RED on purpose. It reproduces the bug at the
// in-process / full-pipeline layer (PatternManager.compilePattern →
// runtime.run) so we get red-green TDD on a fix. When the underlying
// merge/traversal is fixed, this test should pass without changes here.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - CT-1562 Default<[]> anyOf merge drops array-ness", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let errors: unknown[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    errors = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rooms.map(...).join() returns the joined string when rooms has Default<[]>", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, pattern, UI } from 'commonfabric';",
            "",
            "interface Room {",
            "  name: string;",
            "  messages: string[] | Default<[]>;",
            "}",
            "interface Conversation {",
            "  rooms: Room[] | Default<[]>;",
            "}",
            "interface Input { conversation: Conversation; }",
            "",
            "export default pattern<Input>(({ conversation }) => {",
            "  const rooms = conversation.rooms;",
            "  const roomSummaryText = rooms",
            "    .map((room) => `${room.name}: ${room.messages.length}`)",
            "    .join('\\n');",
            "  return { roomSummaryText };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    const patternId = runtime.patternManager.registerPattern(
      compiled,
      program,
    );
    await runtime.patternManager.saveAndSyncPattern({ patternId, space });

    const loaded = await runtime.patternManager.loadPattern(
      patternId,
      space,
      tx,
    );
    const resultCell = runtime.getCell<{ roomSummaryText: string }>(
      space,
      "ct1562-default-anyof-merge",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      loaded,
      {
        conversation: {
          rooms: [
            { name: "alpha", messages: ["one", "two"] },
            { name: "beta", messages: [] },
          ],
        },
      },
      resultCell,
    );
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

    // Surface scheduler errors (the SES path emits `TypeError: rooms.map is
    // not a function`; the in-process trusted-builder path may instead
    // silently produce a non-array `rooms` and crash at `.map`).
    if (errors.length > 0) {
      console.log("CT-1562 scheduler errors:", errors);
    }

    const queryResult = result.getAsQueryResult();
    console.log("CT-1562 queryResult:", queryResult);
    const direct = result.key("roomSummaryText").get();
    console.log("CT-1562 direct read of roomSummaryText:", direct);

    expect((queryResult as { roomSummaryText?: string })?.roomSummaryText)
      .toBe("alpha: 2\nbeta: 0");
  });
});
