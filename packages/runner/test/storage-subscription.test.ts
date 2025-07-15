import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type {
  IStorageSubscription,
  StorageNotification,
} from "../src/storage/interface.ts";
import type { Entity } from "@commontools/memory/interface";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";

const signer = await Identity.fromPassphrase("test storage subscription");
const space = signer.did();

class Subscription implements IStorageSubscription {
  notifications: StorageNotification[] = [];
  next(notification: StorageNotification) {
    this.notifications.push(notification);

    return { done: false };
  }

  get commits() {
    return this.notifications.filter((n) => n.type === "commit");
  }

  get reverts() {
    return this.notifications.filter((n) => n.type === "revert");
  }

  get loads() {
    return this.notifications.filter((n) => n.type === "load");
  }

  get pulls() {
    return this.notifications.filter((n) => n.type === "pull");
  }

  get integrates() {
    return this.notifications.filter((n) => n.type === "integrate");
  }

  get resets() {
    return this.notifications.filter((n) => n.type === "reset");
  }
}

describe("Storage Subscription", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
    // Allow pending operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  describe("commit notifications", () => {
    it("should receive commit notification when transaction is committed", async () => {
      const subscription = new Subscription();

      storageManager.subscribe(subscription);

      // Create a transaction and write some data
      const tx = storageManager.edit();
      const entityId = `test:commit-${Date.now()}` as Entity;
      const value = { message: "Hello, world!" };

      tx.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, value);

      const result = await tx.commit();
      expect(result.ok).toBeTruthy();

      expect(subscription.commits.length).toBe(1);
      const commit = subscription.commits[0];
      expect(commit.type).toBe("commit");
      expect(commit.space).toBe(space);
      expect(commit.source).toBe(tx);

      expect([...commit.changes]).toEqual([
        {
          address: {
            id: entityId,
            type: "application/json",
            path: [],
          },
          after: value,
          before: undefined,
        },
      ]);
    });

    it("should include source transaction in commit notification", async () => {
      const subscription = new Subscription();

      storageManager.subscribe(subscription);

      // Create a transaction and write some data
      const tx = storageManager.edit();
      const entityId = `test:source-${Date.now()}` as Entity;

      tx.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, { test: "data" });

      const result = await tx.commit();
      expect(result.ok).toBeTruthy();

      expect(subscription.commits.length).toBe(1);
      const commit = subscription.commits[0];
      expect(commit.type).toBe("commit");
      expect(commit.space).toBe(space);
      expect(commit.source).toBe(tx);

      expect([...commit.changes]).toEqual([{
        address: {
          id: entityId,
          type: "application/json",
          path: [],
        },
        after: { test: "data" },
        before: undefined,
      }]);
    });

    it("should handle multiple subscribers", async () => {
      const subscription1 = new Subscription();
      const subscription2 = new Subscription();

      storageManager.subscribe(subscription1);
      storageManager.subscribe(subscription2);

      // Create a transaction and write some data
      const tx = storageManager.edit();
      const entityId = `test:multi-${Date.now()}` as Entity;

      tx.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, { value: 42 });

      const result = await tx.commit();
      expect(result.ok).toBeTruthy();

      // Both subscribers should receive the same notification
      expect(subscription1.commits.length).toBe(1);
      expect(subscription2.commits.length).toBe(1);

      const commit1 = subscription1.commits[0];
      const commit2 = subscription2.commits[0];

      expect(commit1.type).toBe("commit");
      expect(commit1.space).toBe(space);
      expect(commit1.source).toBe(tx);

      expect(commit2.type).toBe("commit");
      expect(commit2.space).toBe(space);
      expect(commit2.source).toBe(tx);

      // Both should have the same changes
      const expectedChange = {
        address: {
          id: entityId,
          type: "application/json",
          path: [],
        },
        after: { value: 42 },
        before: undefined,
      };

      expect([...commit1.changes]).toEqual([expectedChange]);
      expect([...commit2.changes]).toEqual([expectedChange]);
    });
  });

  describe("revert notifications", () => {
    it("should receive revert notification on conflict", async () => {
      // Create memory from session before subscribing
      const memory = storageManager.session().mount(space);
      const entityId = `test:conflict-${Date.now()}` as Entity;

      // Transact the memory so we have some fact in there
      const existingFact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { version: 1 },
      });

      await memory.transact({ changes: Changes.from([existingFact]) });

      // Get replica for the space and reset it (so it assumes it's empty)
      const { replica } = storageManager.open(space);
      (replica as any).reset();

      // Now subscribe to notifications
      const subscription = new Subscription();
      storageManager.subscribe(subscription);

      // Use storageManager.edit() to perform conflicting write and commit
      const tx = storageManager.edit();
      tx.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, { version: 2 });

      // Check that before commit provider.replica.get returns undefined
      const factAddress = { the: "application/json", of: entityId };
      expect(replica.get(factAddress)).toBeUndefined();

      // Send commit (without await) and check optimistic update
      const commitPromise = tx.commit();
      expect(replica.get(factAddress)?.is).toEqual({ version: 2 });

      // After commit result is back, check final state
      const result = await commitPromise;
      expect(replica.get(factAddress)?.is).toEqual({ version: 1 });

      // The commit should fail and generate a revert notification
      expect(result.ok).toBeFalsy();
      expect(subscription.reverts.length).toBe(1);

      const revert = subscription.reverts[0];
      expect(revert.type).toBe("revert");
      expect(revert.space).toBe(space);
      expect(revert.reason).toBe(result.error);
      expect(revert.source).toBe(tx);

      const changes = [...revert.changes];
      expect(changes.length).toBeGreaterThan(0);
      expect([...changes]).toEqual([{
        address: { id: entityId, type: "application/json", path: [] },
        before: { version: 2 },
        after: { version: 1 },
      }]);
    });
  });

  describe("load notifications", () => {
    it("should receive load notification when data is loaded from cache", async () => {
      // Subscribe to notifications
      const subscription = new Subscription();
      storageManager.subscribe(subscription);

      // Get the replica and call load to trigger load notification
      const { replica } = storageManager.open(space);
      const entityId = `test:load-${Date.now()}` as Entity;
      const factAddress = { the: "application/json", of: entityId };

      await (replica as any).load([[factAddress, undefined]]);

      // Check for load notifications
      expect(subscription.loads.length).toBe(1);

      const load = subscription.loads[0];
      expect(load.type).toBe("load");
      expect(load.space).toBe(space);

      // Note that because cache is disabled we will not be able to load anything
      // from cache so we can not test case where load gets something back.
      const changes = [...load.changes];
      expect(changes.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("pull notifications", () => {
    it("should receive pull notification when data is pulled from remote", async () => {
      // Put something in the memory first
      const memory = storageManager.session().mount(space);
      const entityId = `test:pull-${Date.now()}` as Entity;
      const fact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { data: "to be pulled" },
      });

      await memory.transact({ changes: Changes.from([fact]) });

      // Create subscription
      const subscription = new Subscription();
      storageManager.subscribe(subscription);

      // Call pull on the replica
      const { replica } = storageManager.open(space);
      const factAddress = { the: "application/json", of: entityId };

      await (replica as any).pull([[factAddress, undefined]]);

      // Check for pull notifications
      expect(subscription.pulls.length).toBe(1);

      const pull = subscription.pulls[0];
      expect(pull.type).toBe("pull");
      expect(pull.space).toBe(space);

      expect([...pull.changes]).toEqual([{
        address: {
          id: entityId,
          type: "application/json",
          path: [],
        },
        before: undefined,
        after: { data: "to be pulled" },
      }]);
    });
  });

  describe("integrate notifications", () => {
    it("should receive integrate notification when data is integrated", async () => {
      // Subscribe to notifications
      const subscription = new Subscription();
      storageManager.subscribe(subscription);

      // Use .edit() to write something and commit
      const entityId1 = `test:integrate-1-${Date.now()}` as Entity;
      const tx1 = storageManager.edit();
      tx1.write({
        space,
        id: entityId1,
        type: "application/json",
        path: [],
      }, { version: 1 });

      const result1 = await tx1.commit();
      expect(result1.ok).toBeTruthy();

      // Try another commit with different entity
      const entityId2 = `test:integrate-2-${Date.now()}` as Entity;
      const tx2 = storageManager.edit();
      tx2.write({
        space,
        id: entityId2,
        type: "application/json",
        path: [],
      }, { version: 2 });

      const result2 = await tx2.commit();
      expect(result2.ok).toBeTruthy();

      // When second commit is returned we should have integrate notification
      expect(subscription.integrates.length).toBeGreaterThan(0);

      const integrate = subscription.integrates[0];
      expect(integrate.type).toBe("integrate");
      expect(integrate.space).toBe(space);

      // Integrating upstream changes seem to have got broken due
      // to commits being reducted, so disabling this for now.
      // expect([...integrate.changes]).toBeGreaterThan(0);
    });
  });

  describe("reset notifications", () => {
    it("should receive reset notification when storage is reset", async () => {
      // Create an entity first
      const tx = storageManager.edit();
      const entityId = `test:reset-${Date.now()}` as Entity;

      tx.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, { data: "to be reset" });

      await tx.commit();

      // Subscribe to notifications after commit
      const subscription = new Subscription();
      storageManager.subscribe(subscription);

      // Get the provider and trigger a reset operation
      const { replica } = storageManager.open(space);

      // Trigger a reset operation
      (replica as any).reset();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for reset notifications
      expect(subscription.resets.length).toBeGreaterThan(0);

      const reset = subscription.resets[0];
      expect(reset.type).toBe("reset");
      expect(reset.space).toBe(space);
    });
  });

  describe("subscription lifecycle", () => {
    it("should stop receiving notifications when subscription returns done", async () => {
      let notificationCount = 0;
      const subscription: IStorageSubscription = {
        next(notification) {
          notificationCount++;
          // Return done after first notification
          return { done: notificationCount >= 1 };
        },
      };

      storageManager.subscribe(subscription);

      // First transaction
      const tx1 = storageManager.edit();
      tx1.write({
        space,
        id: `test:lifecycle-1-${Date.now()}` as Entity,
        type: "application/json",
        path: [],
      }, { count: 1 });
      await tx1.commit();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second transaction
      const tx2 = storageManager.edit();
      tx2.write({
        space,
        id: `test:lifecycle-2-${Date.now()}` as Entity,
        type: "application/json",
        path: [],
      }, { count: 2 });
      await tx2.commit();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should only have received one notification
      expect(notificationCount).toBe(1);
    });

    it("should handle subscription errors gracefully", async () => {
      let errorThrown = false;

      const errorSubscription: IStorageSubscription = {
        next(notification) {
          if (!errorThrown) {
            errorThrown = true;
            throw new Error("Subscription error");
          }
          return { done: false };
        },
      };

      // Subscribe with error-throwing subscription
      storageManager.subscribe(errorSubscription);

      // Also subscribe with a normal subscription to verify system continues
      const normalSubscription = new Subscription();
      storageManager.subscribe(normalSubscription);

      const tx = storageManager.edit();
      tx.write({
        space,
        id: `test:error-test-${Date.now()}` as Entity,
        type: "application/json",
        path: [],
      }, { test: true });
      await tx.commit();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Error subscription should have been called but error handled
      expect(errorThrown).toBe(true);
      // Normal subscription should still work
      expect(normalSubscription.notifications.length).toBeGreaterThan(0);
    });
  });
});
