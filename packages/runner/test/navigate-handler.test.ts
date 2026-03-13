import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("handler can update local state and still navigate", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: async (target) => {
      navigations.push(target.entityId?.["/"] ?? "");
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const { commontools } = createBuilder();
    const {
      NAME,
      Writable,
      handler,
      navigateTo,
      pattern,
    } = commontools;

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
      navigateCallback: async (target) => {
        navigations.push(target.entityId?.["/"] ?? "");
      },
    });

    const tx: IExtendedStorageTransaction = runtime.edit();

    try {
      const { commontools } = createBuilder();
      const {
        NAME,
        Writable,
        handler,
        navigateTo,
        pattern,
      } = commontools;

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
