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

  it("should merge child invariants into matching parent invariants", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Put multiple invariants at different path depths
    // Order matters! When we put a parent, it overwrites children
    const user = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { profile: { name: "Root", settings: { theme: "light" } } },
    } as const;

    const profile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Profile Level", settings: { theme: "dark" } },
    } as const;

    const settings = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings"],
      },
      value: { theme: "custom" },
    } as const;

    // Claim in order - each claim should merge appropriately
    invariants.claim(user);
    expect(invariants.get(settings.address)).toEqual(user);

    invariants.claim(profile);
    expect(invariants.get(settings.address)).toEqual({
      address: user.address,
      value: {
        ...user.value,
        profile: {
          ...user.value.profile,
          ...profile.value,
        },
      },
    });

    invariants.claim(settings);

    // After claiming all invariants, they should be merged into a single root invariant
    const merged = {
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
    expect(invariants.get(user.address)).toEqual(merged);
    expect(invariants.get(profile.address)).toEqual(merged);
    expect(invariants.get(settings.address)).toEqual(merged);
    expect(invariants.get({
      ...user.address,
      path: ["profile", "settings", "theme"],
    })).toEqual(merged);

    expect(invariants.get({
      ...user.address,
      path: ["profile", "name"],
    })).toEqual(merged);
  });

  it("should overwrite child invariants with a parent", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First put child invariants
    const name = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Alice",
    } as const;

    const theme = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      },
      value: "dark",
    } as const;

    invariants.claim(name);
    invariants.claim(theme);

    // Verify children exist
    expect(invariants.get(name.address)).toEqual(name);
    expect(invariants.get(theme.address)).toEqual(theme);
    expect(invariants.get({
      ...name.address,
      path: ["profile"],
    })).toBeUndefined();
    expect(invariants.get({
      ...name.address,
      path: ["profile", "settings"],
    })).toBeUndefined();

    // Now put parent invariant
    const profile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Bob", email: "bob@example.com" },
    } as const;

    invariants.claim(profile);

    // Children should be gone, only parent remains
    expect(invariants.get(name.address)).toEqual(profile);
    expect(invariants.get(name.address)).toEqual(profile);
    expect(invariants.get(name.address)).toEqual(profile);
  });

  it("should handle different entities independently", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const alice = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice" },
    } as const;

    const bob = {
      address: {
        id: "user:2",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Bob" },
    } as const;

    invariants.claim(alice);
    invariants.claim(bob);

    // Both should exist independently
    expect(invariants.get(alice.address)).toEqual(alice);
    expect(invariants.get(bob.address)).toEqual(bob);
  });

  it("should be iterable", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const alice = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { name: "Alice" },
    } as const;

    const bob = {
      address: {
        id: "user:2",
        type: "application/json",
        path: [],
      },
      value: { name: "Bob" },
    } as const;

    invariants.claim(alice);
    invariants.claim(bob);

    const collected = [...invariants];
    expect(collected).toHaveLength(2);
    expect(collected).toContainEqual(alice);
    expect(collected).toContainEqual(bob);
  });

  it("should merge child writes into parent invariants using claim", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Start with a parent invariant
    const profile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice", email: "alice@example.com" },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(profile);

    expect(invariants.get(profile.address)).toEqual(profile);

    // Now claim a child write that should merge into the parent
    const name = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Bob",
    } as const;

    const result = invariants.claim(name);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Should have merged into the parent, creating a new invariant at root level
    // with the updated profile.name value
    const merged = {
      address: profile.address,
      value: {
        profile: { name: "Bob", email: "alice@example.com" },
        settings: { theme: "light" },
      },
    };
    expect(invariants.get(profile.address)).toEqual(merged);

    // Query for the specific path should still work
    expect(invariants.get(name.address)).toEqual(merged); // Should return the same merged invariant
  });

  it("should keep parallel paths separate and include both in iterator", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Create invariants for different parallel paths that don't merge
    const userProfile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice" },
    } as const;

    const userSettings = {
      address: {
        id: "user:1",
        type: "application/json", 
        path: ["settings"],
      },
      value: { theme: "dark" },
    } as const;

    const projectData = {
      address: {
        id: "project:1",
        type: "application/json",
        path: ["data"],
      },
      value: { title: "My Project" },
    } as const;

    invariants.claim(userProfile);
    invariants.claim(userSettings);
    invariants.claim(projectData);

    // Parallel paths should remain separate
    expect(invariants.get(userProfile.address)).toEqual(userProfile);
    expect(invariants.get(userSettings.address)).toEqual(userSettings);
    expect(invariants.get(projectData.address)).toEqual(projectData);

    // Iterator should include all separate invariants
    const collected = [...invariants];
    expect(collected).toHaveLength(3);
    expect(collected).toContainEqual(userProfile);
    expect(collected).toContainEqual(userSettings);
    expect(collected).toContainEqual(projectData);
  });

  it("should show merged invariant in iterator, not original invariants", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Start with a parent invariant
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { 
        profile: { name: "Alice", email: "alice@example.com" },
        settings: { theme: "light" }
      },
    } as const;

    invariants.claim(parent);

    // Iterator should show the parent
    let collected = [...invariants];
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(parent);

    // Now claim child invariants that should merge into the parent
    const nameUpdate = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Bob",
    } as const;

    const themeUpdate = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["settings", "theme"],
      },
      value: "dark",
    } as const;

    invariants.claim(nameUpdate);
    invariants.claim(themeUpdate);

    // After merging, iterator should only show the merged invariant at root
    collected = [...invariants];
    expect(collected).toHaveLength(1);
    
    // The single invariant should be the merged result at root path
    const merged = collected[0];
    expect(merged.address.path).toEqual([]);
    expect(merged.value).toEqual({
      profile: { name: "Bob", email: "alice@example.com" },
      settings: { theme: "dark" }
    });
    
    // Original individual updates should not appear as separate items
    expect(collected).not.toContainEqual(nameUpdate);
    expect(collected).not.toContainEqual(themeUpdate);
  });

  it("should overwrite child invariants when parent is claimed in iterator", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // Start with child invariants
    const name = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Alice",
    } as const;

    const email = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      },
      value: "alice@example.com",
    } as const;

    const theme = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["settings", "theme"],
      },
      value: "dark",
    } as const;

    invariants.claim(name);
    invariants.claim(email);
    invariants.claim(theme);

    // Before overwriting, iterator should show individual child invariants
    let collected = [...invariants];
    expect(collected).toHaveLength(3);
    expect(collected).toContainEqual(name);
    expect(collected).toContainEqual(email);
    expect(collected).toContainEqual(theme);

    // Now claim a parent that overwrites the profile children
    const profile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Bob", age: 30 },
    } as const;

    invariants.claim(profile);

    // After overwriting, iterator should show the parent and unaffected invariants
    collected = [...invariants];
    expect(collected).toHaveLength(2);
    
    // Profile parent should be in the iterator
    expect(collected).toContainEqual(profile);
    
    // Settings theme should still be there (unaffected parallel path)
    expect(collected).toContainEqual(theme);
    
    // Original profile children should be gone
    expect(collected).not.toContainEqual(name);
    expect(collected).not.toContainEqual(email);

    // Verify that getting the child paths returns the parent
    expect(invariants.get(name.address)).toEqual(profile);
    expect(invariants.get(email.address)).toEqual(profile);
  });
});
