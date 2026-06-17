import { assert, assertEquals } from "@std/assert";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { navigateTo as rawNavigateTo } from "../src/builtins/navigate-to.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

async function runNavigateHandlerTest(conditional: boolean): Promise<void> {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const {
      NAME,
      Writable,
      handler,
      ifElse,
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
          menuOpen: { type: "boolean", asCell: ["cell"] },
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
        openNote: conditional
          ? ifElse(menuOpen, openNote({ menuOpen }), undefined)
          : openNote({ menuOpen }),
      };
    });

    const resultCell = runtime.getCell<{
      menuOpen: boolean;
      openNote?: unknown;
    }>(
      space,
      {
        navigateHandler: {
          conditional,
        },
      },
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
}

Deno.test("handler can update local state and still navigate", async () => {
  await runNavigateHandlerTest(false);
});

Deno.test("conditional handler still navigates after it hides itself", async () => {
  await runNavigateHandlerTest(true);
});

Deno.test("navigateTo is idempotent for one result cell", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const processCell = runtime.getCell(
      space,
      "navigateTo idempotent result cell",
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
      assertEquals(
        (result as { getAsNormalizedFullLink(): { scope: string } })
          .getAsNormalizedFullLink().scope,
        "session",
      );
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
    assertEquals(navigations[0], entityRefToString(targetOne.entityId));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test(
  "navigateTo retries navigation after a rejected post-commit transaction",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const navigations: string[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      navigateCallback: (target) => {
        navigations.push(entityRefToString(target.entityId));
      },
    });

    try {
      const setupTx: IExtendedStorageTransaction = runtime.edit();
      const processCell = runtime.getCell(
        space,
        "navigateTo retry result cell",
        undefined,
        setupTx,
      );
      const target = runtime.getCell(
        space,
        "navigateTo retry target",
        undefined,
        setupTx,
      );
      target.set({ title: "retry target" });
      const inputs = runtime.getImmutableCell(
        space,
        target.getAsLink(),
        undefined,
        setupTx,
      );
      const setupResult = await setupTx.commit();
      assert(setupResult.ok !== undefined);

      const sendResult = (
        resultTx: IExtendedStorageTransaction,
        result: unknown,
      ) => {
        processCell.withTx(resultTx).key("result").set(result);
      };

      const builtin = rawNavigateTo(
        inputs,
        sendResult,
        () => {},
        [],
        processCell,
        runtime,
      );

      const rejectedTx = runtime.edit();
      rejectedTx.setCfcEnforcementMode("enforce-explicit");
      rejectedTx.markCfcRelevant("navigateTo retry regression");
      builtin.action(rejectedTx);
      const rejectedResult = await rejectedTx.commit();
      assert(rejectedResult.error !== undefined);
      await runtime.idle();
      assertEquals(navigations.length, 0);

      const retryTx = runtime.edit();
      builtin.action(retryTx);
      const retryResult = await retryTx.commit();
      assert(retryResult.ok !== undefined);
      await runtime.idle();

      assertEquals(navigations.length, 1);
      assertEquals(navigations[0], entityRefToString(target.entityId));
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);
