import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Verifies the "lift() in a handler-created piece resolves only at 1 hop"
// gotcha against a REAL navigateTo chain (not pattern composition):
//
//   Root --(handler -> navigateTo)--> Viewer({ items })
//     Viewer builds a lift from `items` in its OWN body        (1 hop)
//     Viewer delegates `items` to a nested Child pattern that
//     builds the same lift                                     (2 hops)
//
// We capture the navigated-to Viewer cell via navigateCallback and read both
// the 1-hop and 2-hop lift outputs. The hypothesis predicted the 2-hop lift
// would be empty; this test records what actually happens.

const signer = await Identity.fromPassphrase("navigate lift hops operator");
const space = signer.did();

async function runNavigateLiftHopsTest(pullMode: boolean): Promise<void> {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigatedTargets: Cell<any>[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigatedTargets.push(target);
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    if (pullMode) runtime.scheduler.enablePullMode();
    else runtime.scheduler.disablePullMode();

    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, lift, navigateTo, pattern } = commonfabric;

    type Item = { label?: string };

    const summarizeItems = lift((items: Item[] | undefined) => {
      const list = Array.isArray(items) ? items : [];
      return {
        count: list.length,
        labels: list.map((it) => it?.label ?? "").join(","),
      };
    });

    // 2-hop: nested child builds the lift from the delegated `items` cell.
    const Child = pattern((args: { items: Item[] }) => {
      const nestedSummary = summarizeItems(args.items);
      return { nestedSummary };
    });

    // 1-hop: Viewer builds the lift in its own body, and also delegates the
    // cell to the nested Child.
    const Viewer = pattern((args: { items: Item[] }) => {
      const ownSummary = summarizeItems(args.items);
      return {
        ownSummary,
        child: Child({ items: args.items }),
      };
    });

    const openViewer = handler(
      { type: "object", properties: {} },
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" } },
            },
            asCell: ["cell"],
          },
        },
        required: ["items"],
      },
      (_event, { items }) => {
        return navigateTo(Viewer({ items }));
      },
    );

    const Root = pattern(() => {
      const items = commonfabric.Writable.of<Item[]>([
        { label: "alpha" },
        { label: "beta" },
        { label: "gamma" },
      ]);
      return {
        items,
        open: openViewer({ items }),
      };
    });

    const resultCell = runtime.getCell<{ open?: unknown }>(
      space,
      { navigateLiftHops: { pullMode } },
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await result.pull();

    result.key("open").send({});
    await runtime.idle();
    await result.pull();

    assertEquals(navigatedTargets.length, 1);
    const target = navigatedTargets[0];
    await target.pull();
    await runtime.idle();

    // 1-hop lift (Viewer's own body).
    const ownSummary = await target.key("ownSummary").pull() as {
      count: number;
      labels: string;
    };
    // 2-hop lift (nested Child).
    const nestedSummary = await target
      .key("child")
      .key("nestedSummary")
      .pull() as { count: number; labels: string };

    assertEquals(
      ownSummary?.count,
      3,
      `1-hop lift count (${pullMode ? "pull" : "push"})`,
    );
    assertEquals(
      ownSummary?.labels,
      "alpha,beta,gamma",
      `1-hop lift labels (${pullMode ? "pull" : "push"})`,
    );
    assertEquals(
      nestedSummary?.count,
      3,
      `2-hop nested-child lift count (${pullMode ? "pull" : "push"})`,
    );
    assertEquals(
      nestedSummary?.labels,
      "alpha,beta,gamma",
      `2-hop nested-child lift labels (${pullMode ? "pull" : "push"})`,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

for (const pullMode of [false, true]) {
  const mode = pullMode ? "pull" : "push";
  Deno.test(
    `navigateTo'd piece resolves lift at both 1 and 2 hops (${mode} mode)`,
    async () => {
      await runNavigateLiftHopsTest(pullMode);
    },
  );
}
