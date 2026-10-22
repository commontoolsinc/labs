/**
 * Runs the real Home pattern (`packages/patterns/system/home.tsx`) and drives
 * its `retireProfile` and `restoreProfile` streams over profiles its own
 * `createProfile` made, so that the list they write is stored in the shape
 * Home stores it: a document of its own, which Home's result links. The
 * picker runs over Home's own lists where a case drives its controls. The
 * untrusted writes go in under Home's result schema and through the stored
 * document's own address.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { click, elementsLabeled } from "./support/vnode-text.ts";

const signer = await Identity.fromPassphrase("profile retire");
const home = signer.did();

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/** The space `profile` lives in. */
function spaceOf(profile: Cell<unknown>): string {
  return profile.getAsNormalizedFullLink().space;
}

describe("profile-retire", () => {
  let manager: EmulatedStorageManager;
  let rt: Runtime;
  let host: Cell<Record<string, unknown>>;
  let resultSchema: JSONSchema | undefined;
  let ada: Cell<unknown>;
  let alan: Cell<unknown>;
  let grace: Cell<unknown>;

  beforeEach(async () => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const program = await systemProgram("home.tsx");
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    resultSchema = pattern.resultSchema;
    host = rt.getCell<Record<string, unknown>>(home, "home", undefined, tx);
    const result = rt.run(tx, pattern, {}, host);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await create("Ada");
    await create("Alan");
    await create("Grace");
    [ada, alan, grace] = links("profiles");
  });

  afterEach(async () => {
    rt.runner.stop(host);
    await rt.dispose({ closeStorage: false });
    await manager.close();
  });

  /** The program of the system pattern `name`, resolved from the checkout. */
  function systemProgram(name: string) {
    return resolveLocalProgram(
      (resolver) => rt.harness.resolve(resolver),
      {
        main: new URL(`../../patterns/system/${name}`, import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
  }

  /**
   * Runs the picker over Home's own lists, as Home's Profile tab does, and
   * returns its result and a reading of its view.
   */
  async function pickerOverHome() {
    const program = await systemProgram("profile-picker.tsx");
    const tx = rt.edit();
    const picker = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      home,
      "picker over Home",
      undefined,
      tx,
    );
    const result = rt.run(tx, picker, {
      profiles: host.key("profiles"),
      defaultProfile: host.key("defaultProfile"),
      legacyDefaultProfile: host.key("legacyDefaultProfile"),
      mru: host.key("mru"),
      retiredProfiles: host.key("retiredProfiles"),
    }, cell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return { result, ui: () => result.key("$UI").get() };
  }

  /** A click on the picker surface's control `action`, as the renderer marks one. */
  function pickerGesture(action: string): unknown {
    const event = {
      type: "click",
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfilePickerSurface",
        action,
      }),
    };
    markRendererTrustedEvent(event);
    return event;
  }

  /** Sends `event` on Home's stream `stream`, and settles. */
  async function send(stream: string, event: unknown): Promise<void> {
    const tx = rt.edit();
    host.withTx(tx).key(stream).send(event);
    await tx.commit().settled;
    await rt.idle();
    await host.pull();
  }

  /** Creates a profile named `name`, as a click on the create form does. */
  async function create(name: string): Promise<void> {
    const event = {
      type: "click",
      name,
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfileCreateSurface",
        action: "CreateProfile",
      }),
    };
    markRendererTrustedEvent(event);
    await send("createProfile", event);
  }

  /** The links Home's list under `key` holds. */
  function links(key: string): readonly Cell<unknown>[] {
    return host.key(key).asSchema(linkListSchema).get() ?? [];
  }

  /** The spaces of the profiles Home lists as retired, in order. */
  function retired(): string[] {
    return links("retiredProfiles").map(spaceOf);
  }

  /**
   * Commits what `write` writes with no handler's authority, and returns the
   * commit's error message.
   */
  async function untrusted(
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string | undefined> {
    const tx = rt.edit();
    write(tx);
    tx.prepareCfc();
    const { error } = await tx.commit().settled;
    await rt.idle();
    return error?.message;
  }

  /** A click on the picker's control labeled `label`, in row `row`. */
  async function clickPicker(
    ui: () => unknown,
    label: string,
    row: number,
    action: string,
  ): Promise<void> {
    await click(rt, elementsLabeled(ui(), label)[row], pickerGesture(action));
    await host.pull();
  }

  it("retires a profile through Home's retireProfile, and restores it through restoreProfile", async () => {
    await send("retireProfile", { profile: alan });
    expect(retired()).toEqual([spaceOf(alan)]);

    await send("restoreProfile", { profile: alan });
    expect(retired()).toEqual([]);
  });

  it("keeps each profile once, in the order retired, and changes nothing for an event naming no profile", async () => {
    await send("retireProfile", { profile: grace });
    await send("retireProfile", { profile: alan });
    await send("retireProfile", { profile: grace });
    await send("retireProfile", {});
    await send("restoreProfile", {});

    expect(retired()).toEqual([spaceOf(grace), spaceOf(alan)]);
  });

  it("restores nothing for a profile that is not retired", async () => {
    await send("retireProfile", { profile: alan });
    await send("restoreProfile", { profile: grace });

    expect(retired()).toEqual([spaceOf(alan)]);
  });

  it("refuses to retire the first listed profile while no default is set and none was used", async () => {
    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([]);

    await send("retireProfile", { profile: grace });
    expect(retired()).toEqual([spaceOf(grace)]);
  });

  it("refuses to retire the most recently used profile while no default is set, and retires the first listed", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      await clickPicker(ui, "Use", 1, "SetMruProfile");
      expect(links("mru").map(spaceOf)).toEqual([spaceOf(alan)]);

      await send("retireProfile", { profile: alan });
      expect(retired()).toEqual([]);

      await send("retireProfile", { profile: ada });
      expect(retired()).toEqual([spaceOf(ada)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("refuses to retire the profile Home's default names, and retires another", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      await clickPicker(ui, "Set default", 1, "SetDefaultProfile");
      expect(
        spaceOf(host.key("defaultProfile").key("profile").resolveAsCell()),
      ).toBe(spaceOf(alan));

      await send("retireProfile", { profile: alan });
      expect(retired()).toEqual([]);

      await send("retireProfile", { profile: ada });
      expect(retired()).toEqual([spaceOf(ada)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("refuses to retire the last live profile", async () => {
    await send("retireProfile", { profile: alan });
    await send("retireProfile", { profile: grace });
    expect(retired()).toEqual([spaceOf(alan), spaceOf(grace)]);

    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([spaceOf(alan), spaceOf(grace)]);
  });

  it("offers Remove on every row but the one `#profile` returns, and retires a profile through the confirmed Remove", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      expect(elementsLabeled(ui(), "Remove…")).toHaveLength(2);

      await click(rt, elementsLabeled(ui(), "Remove…")[0]);
      await result.pull();
      await click(rt, elementsLabeled(ui(), "Remove profile")[0]);
      await host.pull();

      expect(retired()).toEqual([spaceOf(alan)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("refuses an untrusted write to the list, whole or at an element", async () => {
    await send("retireProfile", { profile: grace });
    const viaResult = (tx: IExtendedStorageTransaction) =>
      rt.getCell(home, "home", resultSchema, tx).key("retiredProfiles");

    expect(await untrusted((tx) => viaResult(tx).set([]))).toContain(
      "writePolicyAnyOf failed",
    );
    expect(
      await untrusted((tx) =>
        host.withTx(tx).key("retiredProfiles").resolveAsCell().set([])
      ),
    ).toContain("writePolicyAnyOf failed");
    expect(
      await untrusted((tx) => viaResult(tx).key(0).set(alan.resolveAsCell())),
    ).toContain("writePolicyAnyOf failed");
    expect(
      await untrusted((tx) =>
        viaResult(tx).set([ada, alan].map((each) => each.resolveAsCell()))
      ),
    ).toContain("writePolicyAnyOf failed");
    expect(retired()).toEqual([spaceOf(grace)]);
  });
});
