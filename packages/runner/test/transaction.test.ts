import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { History, Novelty } from "../src/storage/cache.ts";
import { Identity } from "@commontools/identity";
import type {
  IMemoryAddress,
  ITransactionInvariant,
} from "../src/storage/interface.ts";

describe("WriteInvariants", () => {
  it("should store and retrieve invariants by exact address", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const invariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    };

    invariants.claim(invariant);

    const retrieved = invariants.get(invariant.address);
    expect(retrieved).toEqual(invariant);
  });

  it("should return undefined for non-existent invariant", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const address: IMemoryAddress = {
      id: "user:999",
      type: "application/json",
      path: [],
    };

    const retrieved = invariants.get(address);
    expect(retrieved).toBeUndefined();
  });

  it("should return parent invariant for nested path", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const parentInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    };

    invariants.claim(parentInvariant);

    // Query for a nested path should return the parent invariant
    const nestedAddress: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "name"],
    };

    const retrieved = invariants.get(nestedAddress);
    expect(retrieved).toEqual(parentInvariant);
  });

  it("should understand the key comparison logic", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Put a root invariant
    const rootInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { profile: { name: "Root" } },
    };

    invariants.claim(rootInvariant);

    // Query for exact path should return the invariant
    expect(invariants.get(rootInvariant.address)).toEqual(rootInvariant);

    // Query for nested path should return the parent
    const nestedQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile"],
    };
    expect(invariants.get(nestedQuery)).toEqual(rootInvariant);
  });

  it("should return deepest matching parent for nested queries", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Put multiple invariants at different path depths
    // Order matters! When we put a parent, it overwrites children
    const rootInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { profile: { name: "Root", settings: { theme: "light" } } },
    };

    const profileInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Profile Level", settings: { theme: "dark" } },
    };

    const settingsInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings"],
      },
      value: { theme: "custom" },
    };

    // Claim in order - each claim should merge appropriately
    invariants.claim(rootInvariant);
    invariants.claim(profileInvariant);
    invariants.claim(settingsInvariant);

    // After claiming all invariants, they should be merged into a single root invariant
    const expectedMergedInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Profile Level", settings: { theme: "custom" } },
      },
    };

    // All queries should return the same merged invariant
    const rootQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: [],
    };
    expect(invariants.get(rootQuery)).toEqual(expectedMergedInvariant);

    const profileQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile"],
    };
    expect(invariants.get(profileQuery)).toEqual(expectedMergedInvariant);

    const settingsQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "settings"],
    };
    expect(invariants.get(settingsQuery)).toEqual(expectedMergedInvariant);

    const themeQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "settings", "theme"],
    };
    expect(invariants.get(themeQuery)).toEqual(expectedMergedInvariant);

    const nameQuery: IMemoryAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "name"],
    };
    expect(invariants.get(nameQuery)).toEqual(expectedMergedInvariant);
  });

  it("should merge child invariants when parent is claimed", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First put child invariants
    const childInvariant1: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Alice",
    };

    const childInvariant2: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      },
      value: "dark",
    };

    invariants.claim(childInvariant1);
    invariants.claim(childInvariant2);

    // Verify children exist
    expect(invariants.get(childInvariant1.address)).toEqual(childInvariant1);
    expect(invariants.get(childInvariant2.address)).toEqual(childInvariant2);

    // Now put parent invariant
    const parentInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Bob", email: "bob@example.com" },
    };

    invariants.claim(parentInvariant);

    // Children should be gone, only parent remains
    expect(invariants.get(childInvariant1.address)).toEqual(parentInvariant);
    expect(invariants.get(childInvariant2.address)).toEqual(parentInvariant);
    expect(invariants.get(parentInvariant.address)).toEqual(parentInvariant);
  });

  it("should handle different entities independently", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const user1Invariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice" },
    };

    const user2Invariant: ITransactionInvariant = {
      address: {
        id: "user:2",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Bob" },
    };

    invariants.claim(user1Invariant);
    invariants.claim(user2Invariant);

    // Both should exist independently
    expect(invariants.get(user1Invariant.address)).toEqual(user1Invariant);
    expect(invariants.get(user2Invariant.address)).toEqual(user2Invariant);
  });

  it("should be iterable", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const invariant1: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { name: "Alice" },
    };

    const invariant2: ITransactionInvariant = {
      address: {
        id: "user:2",
        type: "application/json",
        path: [],
      },
      value: { name: "Bob" },
    };

    invariants.claim(invariant1);
    invariants.claim(invariant2);

    const collected = [...invariants];
    expect(collected).toHaveLength(2);
    expect(collected).toContainEqual(invariant1);
    expect(collected).toContainEqual(invariant2);
  });

  it("should merge child writes into parent invariants using claim", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Start with a parent invariant
    const parentInvariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice", email: "alice@example.com" },
        settings: { theme: "light" },
      },
    };

    invariants.claim(parentInvariant);

    expect(invariants.get(parentInvariant.address)).toEqual(parentInvariant);

    // Now claim a child write that should merge into the parent
    const childWrite: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Bob",
    };

    const result = invariants.claim(childWrite);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Should have merged into the parent, creating a new invariant at root level
    // with the updated profile.name value
    const retrieved = invariants.get(parentInvariant.address);
    expect(retrieved).toBeDefined();
    expect(retrieved!.address.path).toEqual([]);

    expect(retrieved).toEqual({
      address: parentInvariant.address,
      value: {
        profile: { name: "Bob", email: "alice@example.com" },
        settings: { theme: "light" },
      },
    });

    // Query for the specific path should still work
    const nameQuery = invariants.get(childWrite.address);
    expect(nameQuery).toBe(retrieved); // Should return the same merged invariant
  });

  it("should use put logic when no parent exists for claim", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Claim without any existing parent
    const invariant: ITransactionInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Alice",
    };

    const result = invariants.claim(invariant);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Should be stored as-is since no parent exists
    const retrieved = invariants.get(invariant.address);
    expect(retrieved).toEqual(invariant);
  });
});
