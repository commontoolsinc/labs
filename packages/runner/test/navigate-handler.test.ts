import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { navigateTo as rawNavigateTo } from "../src/builtins/navigate-to.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("handler can update local state and still navigate", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(target.entityId?.["/"] ?? "");
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const {
      NAME,
      Writable,
      handler,
      navigateTo,
      pattern,
    } = commonfabric;

    const Target = pattern(() => ({
      [NAME]: "📝 New Note",
    }));

    const openNote = handler(
      {
        type: "object",
        properties: {},
      },
      {
        type: "object",
        properties: {
          menuOpen: { type: "boolean", asCell: true },
        },
        required: ["menuOpen"],
      },
      (_event, { menuOpen }) => {
        menuOpen.set(false);
        return navigateTo(Target({}));
      },
    );

    const Root = pattern(() => {
      const menuOpen = Writable.of(true);
      return {
        menuOpen,
        openNote: openNote({ menuOpen }),
      };
    });

    const resultCell = runtime.getCell<{
      menuOpen: boolean;
      openNote: unknown;
    }>(
      space,
      "handler can update local state and still navigate",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await result.pull();

    result.key("openNote").send({});
    await runtime.idle();
    await result.pull();

    assert((result.key("menuOpen").get() as unknown) === false);
    assertEquals(navigations.length, 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test(
  "conditional handler still navigates after it hides itself",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const navigations: string[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      navigateCallback: (target) => {
        navigations.push(target.entityId?.["/"] ?? "");
      },
    });

    const tx: IExtendedStorageTransaction = runtime.edit();

    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const {
        NAME,
        Writable,
        handler,
        navigateTo,
        pattern,
      } = commonfabric;

      const Target = pattern(() => ({
        [NAME]: "📝 New Note",
      }));

      const openNote = handler(
        {
          type: "object",
          properties: {},
        },
        {
          type: "object",
          properties: {
            menuOpen: { type: "boolean", asCell: true },
          },
          required: ["menuOpen"],
        },
        (_event, { menuOpen }) => {
          menuOpen.set(false);
          return navigateTo(Target({}));
        },
      );

      const Root = pattern(() => {
        const menuOpen = Writable.of(true);
        return {
          menuOpen,
          openNote: menuOpen ? openNote({ menuOpen }) : undefined,
        };
      });

      const resultCell = runtime.getCell<{
        menuOpen: boolean;
        openNote?: unknown;
      }>(
        space,
        "conditional handler still navigates after it hides itself",
        undefined,
        tx,
      );

      const result = runtime.run(tx, Root, {}, resultCell);
      await tx.commit();
      await result.pull();

      result.key("openNote").send({});
      await runtime.idle();
      await result.pull();

      assert((result.key("menuOpen").get() as unknown) === false);
      assertEquals(navigations.length, 1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);

Deno.test("navigateTo is idempotent for one result process cell", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(target.entityId?.["/"] ?? "");
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const processCell = runtime.getCell(
      space,
      "navigateTo idempotent process cell",
      undefined,
      tx,
    );
    const targetOne = runtime.getCell(
      space,
      "navigateTo idempotent target one",
      undefined,
      tx,
    );
    targetOne.set({ title: "one" });
    const targetTwo = runtime.getCell(
      space,
      "navigateTo idempotent target two",
      undefined,
      tx,
    );
    targetTwo.set({ title: "two" });

    const inputsOne = runtime.getImmutableCell(
      space,
      targetOne.getAsLink(),
      undefined,
      tx,
    );
    const inputsTwo = runtime.getImmutableCell(
      space,
      targetTwo.getAsLink(),
      undefined,
      tx,
    );

    const sendResult = (
      resultTx: IExtendedStorageTransaction,
      result: unknown,
    ) => {
      processCell.withTx(resultTx).key("result").set(result);
    };

    const first = rawNavigateTo(
      inputsOne,
      sendResult,
      () => {},
      [],
      processCell,
      runtime,
    );
    const second = rawNavigateTo(
      inputsTwo,
      sendResult,
      () => {},
      [],
      processCell,
      runtime,
    );

    first.action(tx);
    second.action(tx);
    await tx.commit();
    await runtime.idle();

    assertEquals(navigations.length, 1);
    assertEquals(navigations[0], targetOne.entityId?.["/"]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
