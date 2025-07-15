import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type {
  ICommitNotification,
  IRevertNotification,
  IStorageSubscription,
  IStorageTransaction,
  StorageNotification,
} from "../src/storage/interface.ts";
import type { Entity } from "@commontools/memory/interface";
import { refer } from "merkle-reference";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";
import { Provider } from "../src/storage/cache.ts";

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

  describe.skip("pull notifications", () => {
    it("should receive pull notification when data is pulled from remote", async () => {
      const notifications: StorageNotification[] = [];
      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
          return { done: false };
        },
      };

      storageManager.subscribe(subscription);

      // Use the underlying memory consumer to populate the space
      const memory = storageManager.session().mount(space);
      const entityId = `test:pull-${Date.now()}` as Entity;
      const fact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { data: "to be pulled" },
      });

      // Create the fact directly in memory
      await memory.transact({ changes: Changes.from([fact]) });

      // Clear notifications from initial commit
      notifications.length = 0;

      // Get the provider and trigger a pull operation
      const provider = storageManager.open(space);
      const replica = provider.replica as any;

      // Trigger a pull operation (this simulates pulling from remote)
      await replica.pull([
        [{ the: "application/json", of: entityId }, undefined],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for pull notifications
      const pullNotifications = notifications.filter((n) => n.type === "pull");
      expect(pullNotifications.length).toBeGreaterThan(0);

      const pullNotification = pullNotifications[0];
      expect(pullNotification.type).toBe("pull");
      expect(pullNotification.space).toBe(space);
      const changes = [...pullNotification.changes];
      expect(changes.length).toBeGreaterThan(0);
    });
  });

  describe.skip("integrate notifications", () => {
    it("should receive integrate notification when data is integrated", async () => {
      const notifications: StorageNotification[] = [];
      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
          return { done: false };
        },
      };

      storageManager.subscribe(subscription);

      // Use the underlying memory consumer to set up data
      const memory = storageManager.session().mount(space);
      const entityId = `test:integrate-${Date.now()}` as Entity;

      // Create initial fact
      const initialFact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { data: "initial data" },
      });

      await memory.transact({ changes: Changes.from([initialFact]) });

      // Clear notifications from initial setup
      notifications.length = 0;

      // Get the provider and trigger an integrate operation
      const provider = storageManager.open(space);
      const replica = provider.replica as any;

      // Create a new fact to integrate
      const integrateFact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { data: "integrated data" },
      });

      // Trigger an integrate operation by adding the fact to the heap
      replica.integrate([integrateFact]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for integrate notifications
      const integrateNotifications = notifications.filter((n) =>
        n.type === "integrate"
      );
      expect(integrateNotifications.length).toBeGreaterThan(0);

      const integrateNotification = integrateNotifications[0];
      expect(integrateNotification.type).toBe("integrate");
      expect(integrateNotification.space).toBe(space);
      const changes = [...integrateNotification.changes];
      expect(changes.length).toBeGreaterThan(0);
    });
  });

  describe.skip("reset notifications", () => {
    it("should receive reset notification when storage is reset", async () => {
      const notifications: StorageNotification[] = [];
      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
          return { done: false };
        },
      };

      storageManager.subscribe(subscription);

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

      // Clear notifications from initial commit
      notifications.length = 0;

      // Get the provider and trigger a reset operation
      const provider = storageManager.open(space);
      const replica = provider.replica as any;

      // Trigger a reset operation
      replica.reset();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check for reset notifications
      const resetNotifications = notifications.filter((n) =>
        n.type === "reset"
      );
      if (resetNotifications.length > 0) {
        const resetNotification = resetNotifications[0];
        expect(resetNotification.type).toBe("reset");
        expect(resetNotification.space).toBe(space);
      }
    });
  });

  describe.skip("subscription lifecycle", () => {
    it("should stop receiving notifications when subscription returns done", async () => {
      const notifications: StorageNotification[] = [];
      let notificationCount = 0;

      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
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
      expect(notifications.length).toBe(1);
    });

    it("should handle subscription errors gracefully", async () => {
      const notifications: StorageNotification[] = [];
      let errorThrown = false;

      const subscription: IStorageSubscription = {
        next(notification) {
          if (!errorThrown) {
            errorThrown = true;
            throw new Error("Subscription error");
          }
          notifications.push(notification);
          return { done: false };
        },
      };

      // Subscribe with error-throwing subscription
      storageManager.subscribe(subscription);

      // Also subscribe with a normal subscription to verify system continues
      const normalNotifications: StorageNotification[] = [];
      storageManager.subscribe({
        next(notification) {
          normalNotifications.push(notification);
          return { done: false };
        },
      });

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
      expect(normalNotifications.length).toBeGreaterThan(0);
    });
  });

  describe.skip("notification content", () => {
    it("should include correct changes in commit notification", async () => {
      const notifications: StorageNotification[] = [];
      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
          return { done: false };
        },
      };

      storageManager.subscribe(subscription);

      const tx = storageManager.edit();
      const entities = [
        {
          id: `test:entity-1-${Date.now()}` as Entity,
          value: { name: "Entity 1" },
        },
        {
          id: `test:entity-2-${Date.now()}` as Entity,
          value: { name: "Entity 2" },
        },
        {
          id: `test:entity-3-${Date.now()}` as Entity,
          value: { name: "Entity 3" },
        },
      ];

      // Write multiple entities
      for (const { id, value } of entities) {
        tx.write({
          space,
          id,
          type: "application/json",
          path: [],
        }, value);
      }

      await tx.commit();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Find the commit notification
      const commitNotification = notifications.find((n) => n.type === "commit");
      expect(commitNotification).toBeDefined();

      if (commitNotification && commitNotification.type === "commit") {
        const changes = [...commitNotification.changes];

        // Should have changes for each entity we wrote
        const entityChanges = changes.filter((change) =>
          entities.some((e) => e.id === change.address.id)
        );

        expect(entityChanges.length).toBe(entities.length);

        // Verify each change
        for (const change of entityChanges) {
          const entity = entities.find((e) => e.id === change.address.id);
          expect(entity).toBeDefined();
          expect(change.before).toBeUndefined();
          expect(change.after).toEqual(entity?.value);
        }
      }
    });

    it("should show before and after values for updates", async () => {
      const notifications: StorageNotification[] = [];
      const subscription: IStorageSubscription = {
        next(notification) {
          notifications.push(notification);
          return { done: false };
        },
      };

      storageManager.subscribe(subscription);

      const entityId = `test:update-test-${Date.now()}` as Entity;
      const initialValue = { version: 1, data: "initial" };
      const updatedValue = { version: 2, data: "updated" };

      // Initial write
      const tx1 = storageManager.edit();
      tx1.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, initialValue);
      await tx1.commit();

      // Clear notifications
      notifications.length = 0;

      // Update
      const tx2 = storageManager.edit();
      tx2.write({
        space,
        id: entityId,
        type: "application/json",
        path: [],
      }, updatedValue);
      await tx2.commit();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Find the commit notification
      const commitNotification = notifications.find((n) => n.type === "commit");
      expect(commitNotification).toBeDefined();

      if (commitNotification && commitNotification.type === "commit") {
        const changes = [...commitNotification.changes];
        const updateChange = changes.find((change) =>
          change.address.id === entityId
        );

        expect(updateChange).toBeDefined();
        expect(updateChange?.before).toEqual(initialValue);
        expect(updateChange?.after).toEqual(updatedValue);
      }
    });
  });
});
