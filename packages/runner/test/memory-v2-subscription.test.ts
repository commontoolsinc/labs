import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import type { MIME, URI } from "@commontools/memory/interface";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";

const signer = await Identity.fromPassphrase("memory-v2-storage-subscription");
const space = signer.did();

class Subscription implements IStorageNotification {
  notifications: StorageNotification[] = [];

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    return { done: false };
  }

  get commits() {
    return this.notifications.filter((notification) =>
      notification.type === "commit"
    );
  }

  get reverts() {
    return this.notifications.filter((notification) =>
      notification.type === "revert"
    );
  }
}

const waitFor = async (predicate: () => boolean, timeout = 250): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Memory v2 storage notifications", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    const status = tx?.status();
    if (status?.status === "ready") {
      await tx.commit();
    }
    await runtime.dispose();
    await storageManager.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("emits a commit notification with optimistic changes", async () => {
    const subscription = new Subscription();
    runtime.storageManager.subscribe(subscription);

    const uri = `of:memory-v2-commit-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: "hello" });

    await tx.commit();

    expect(subscription.commits.length).toBeGreaterThanOrEqual(1);
    expect(subscription.commits.at(-1)).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });
    expect([...subscription.commits.at(-1)!.changes].map((change) => change.after))
      .toContainEqual({ value: "hello" });
  });

  it("emits a revert notification when a v2 commit conflicts", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-conflict-${Date.now()}` as URI;
    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 1 },
      })]),
    });

    const { replica } = storageManager.open(space);
    await storageManager.open(space).sync(uri);

    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 3 },
      })]),
    });
    await waitFor(() =>
      JSON.stringify(replica.get({ id: uri, type: "application/json" as MIME })?.is) ===
        JSON.stringify({ value: { version: 3 } })
    );

    const source = {
      journal: {
        activity() {
          return [{
            read: {
              space,
              id: uri,
              type: "application/json",
              path: [],
              meta: { seq: 1 },
            },
          }];
        },
      },
    } as any;

    const factAddress = { id: uri, type: "application/json" as MIME };
    const commitPromise = (replica as any).commit({
      facts: [Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 2 },
      })],
      claims: [],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    expect(subscription.reverts).toHaveLength(1);
    expect(subscription.reverts[0]).toMatchObject({
      type: "revert",
      space,
      source,
    });
    expect(subscription.reverts[0].reason.name).toBe("ConflictError");
    expect([...subscription.reverts[0].changes]).toContainEqual({
      address: { id: uri, type: "application/json", path: [] },
      before: { value: { version: 2 } },
      after: { value: { version: 3 } },
    });
  });

  it("refreshes subscribed state before a conflict revert resolves", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-retry-${Date.now()}` as URI;
    const provider = storageManager.open(space);
    const { replica } = provider;
    await provider.sync(uri);

    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 1 },
      })]),
    });
    await waitFor(() =>
      JSON.stringify(replica.get({ id: uri, type: "application/json" as MIME })?.is) ===
        JSON.stringify({ value: { version: 1 } })
    );

    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 3 },
      })]),
    });

    const source = {
      journal: {
        activity() {
          return [{
            read: {
              space,
              id: uri,
              type: "application/json",
              path: [],
              meta: { seq: 1 },
            },
          }];
        },
      },
    } as any;

    const factAddress = { id: uri, type: "application/json" as MIME };
    const commitPromise = (replica as any).commit({
      facts: [Fact.assert({
        the: "application/json",
        of: uri,
        is: { version: 2 },
      })],
      claims: [],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });
    expect(subscription.reverts.at(-1)).toMatchObject({
      type: "revert",
      space,
      source,
    });
    expect(subscription.reverts.at(-1)?.reason.name).toBe("ConflictError");
  });
});
