import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { History, Novelty } from "../src/storage/cache.ts";
import { Identity } from "@commontools/identity";

describe("WriteInvariants", () => {
  it("should store and retrieve invariants by exact address", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const invariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    } as const;

    invariants.claim(invariant);

    const retrieved = invariants.get(invariant.address);
    expect(retrieved).toEqual(invariant);
  });

  it("should return undefined for non-existent invariant", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    expect(invariants.get({
      id: "user:999",
      type: "application/json",
      path: [],
    })).toBeUndefined();
  });

  it("should return parent invariant for nested path", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    const parentInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    } as const;

    invariants.claim(parentInvariant);

    // Query for a nested path should return the parent invariant
    const nestedAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "name"],
    } as const;

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
        settings: { theme: "light" },
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
      settings: { theme: "dark" },
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

  it("should fail to claim when trying to write to non-object", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with a primitive value at a path
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { name: "Alice" }, // name is a string
    } as const;

    invariants.claim(parent);

    // Try to claim a child that would require writing to the string "Alice"
    const invalidChild = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["name", "firstName"], // trying to access "Alice".firstName
      },
      value: "Alice",
    } as const;

    const result = invariants.claim(invalidChild);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
    expect(result.error?.message).toContain("target is not an object");
  });

  it("should fail to claim when trying to write to null", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with null value
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { data: null },
    } as const;

    invariants.claim(parent);

    // Try to claim a child that would require writing to null
    const invalidChild = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["data", "field"],
      },
      value: "value",
    } as const;

    const result = invariants.claim(invalidChild);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
    expect(result.error?.message).toContain("target is not an object");
  });

  it("should fail to claim when trying to write to array.length", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with an array
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { items: ["a", "b", "c"] },
    } as const;

    invariants.claim(parent);

    // Try to claim a child that would access array.length (which returns undefined)
    const invalidChild = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["items", "length", "something"],
      },
      value: "value",
    } as const;

    const result = invariants.claim(invalidChild);
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("NotFoundError");
    expect(result.error?.message).toContain("target is not an object");
  });

  it("should succeed when adding new property to existing object", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with an existing object
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice" },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(parent);

    // Add a new property to the profile object
    const newProperty = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"], // adding email property that doesn't exist
      },
      value: "alice@example.com",
    } as const;

    const result = invariants.claim(newProperty);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Verify the merged result includes the new property
    const merged = invariants.get(parent.address);
    expect(merged?.value).toEqual({
      profile: {
        name: "Alice",
        email: "alice@example.com", // new property added
      },
      settings: { theme: "light" },
    });

    // Verify querying for the new property returns the merged parent
    expect(invariants.get(newProperty.address)).toBe(merged);
  });

  it("should delete property when undefined is assigned", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with multiple properties
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: {
          name: "Alice",
          email: "alice@example.com",
          age: 30,
        },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(parent);

    // Delete the email property by assigning undefined
    const deleteProperty = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      },
      value: undefined,
    } as const;

    const result = invariants.claim(deleteProperty);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Verify the email property has been deleted
    const merged = invariants.get(parent.address);
    expect(merged?.value).toEqual({
      profile: {
        name: "Alice",
        age: 30,
        // email property should be gone
      },
      settings: { theme: "light" },
    });

    // Verify the deleted property is not present in the merged object
    expect((merged?.value as any)?.profile?.email).toBeUndefined();
  });

  it("should delete nested object when undefined is assigned", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent with nested objects
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: {
          name: "Alice",
          contact: {
            email: "alice@example.com",
            phone: "123-456-7890",
          },
        },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(parent);

    // Delete the entire contact object by assigning undefined
    const deleteContact = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "contact"],
      },
      value: undefined,
    } as const;

    const result = invariants.claim(deleteContact);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Verify the contact object has been deleted
    const merged = invariants.get(parent.address);
    expect(merged?.value).toEqual({
      profile: {
        name: "Alice",
        // contact object should be gone
      },
      settings: { theme: "light" },
    });

    // Verify the deleted contact object is not present
    expect((merged?.value as any)?.profile?.contact).toBeUndefined();
  });

  it("should handle deleting non-existent property gracefully", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent object
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice" },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(parent);

    // Try to delete a property that doesn't exist
    const deleteNonExistent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "nonExistentProperty"],
      },
      value: undefined,
    } as const;

    const result = invariants.claim(deleteNonExistent);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Verify the object remains unchanged (no-op)
    const merged = invariants.get(parent.address);
    expect(merged?.value).toEqual({
      profile: { name: "Alice" },
      settings: { theme: "light" },
    });
  });

  it("should delete property and return unchanged object when same value", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim a parent where a property is already undefined
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: {
          name: "Alice",
          email: undefined as any, // explicitly undefined
        },
      },
    } as const;

    invariants.claim(parent);

    // Try to "delete" the already undefined property
    const deleteAlreadyUndefined = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      },
      value: undefined,
    } as const;

    const result = invariants.claim(deleteAlreadyUndefined);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Should be no-op since target value is already undefined
    const merged = invariants.get(parent.address);
    expect(merged).toEqual(parent); // Should return the original unchanged object
  });

  it("should delete entire object when undefined is assigned to root path", async () => {
    const novelty = new Novelty();
    const identity = await Identity.fromPassphrase("write invariants test");
    const space = identity.did();
    const invariants = novelty.for(space);

    // First claim an object at root path
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice" },
        settings: { theme: "light" },
      },
    } as const;

    invariants.claim(parent);

    // Delete the entire object by assigning undefined to root path
    const deleteRoot = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [], // root path
      },
      value: undefined,
    } as const;

    const result = invariants.claim(deleteRoot);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeDefined();

    // Verify the entire object has been deleted (value is undefined)
    const merged = invariants.get(parent.address);
    expect(merged?.value).toBeUndefined();

    // The invariant should still exist but with undefined value
    expect(merged).toEqual({
      address: parent.address,
      value: undefined,
    });
  });
});

describe("ReadInvariants", () => {
  it("should store and retrieve invariants by exact address", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    const invariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    } as const;

    const result = invariants.claim(invariant);
    expect(result.ok).toBeDefined();
    expect(result.error).toBeUndefined();

    const retrieved = invariants.get(invariant.address);
    expect(retrieved).toEqual(invariant);
  });

  it("should return undefined for non-existent invariant", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    expect(invariants.get({
      id: "user:999",
      type: "application/json",
      path: [],
    })).toBeUndefined();
  });

  it("should return parent invariant for nested path queries", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    const parentInvariant = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    } as const;

    invariants.claim(parentInvariant);

    // Query for a nested path should return the parent invariant
    const nestedAddress = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "name"],
    } as const;

    const retrieved = invariants.get(nestedAddress);
    expect(retrieved).toEqual(parentInvariant);
  });

  it("should detect inconsistency when claiming conflicting invariants", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    // First claim establishes a fact
    const first = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", email: "alice@example.com" },
    } as const;

    const result1 = invariants.claim(first);
    expect(result1.ok).toBeDefined();

    // Second claim with conflicting data should fail
    const conflicting = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Bob", // Conflicts with Alice
    } as const;

    const result2 = invariants.claim(conflicting);
    expect(result2.error).toBeDefined();
    expect(result2.error?.name).toBe("StorageTransactionInconsistent");
  });

  it("should allow consistent child invariants", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    // Parent invariant
    const parent = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: { profile: { name: "Alice", email: "alice@example.com" } },
    } as const;

    const result1 = invariants.claim(parent);
    expect(result1.ok).toBeDefined();

    // Consistent child invariant
    const child = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      },
      value: "Alice", // Matches parent
    } as const;

    const result2 = invariants.claim(child);
    expect(result2.ok).toBeDefined();

    // Both should coexist
    expect(invariants.get(parent.address)).toEqual(parent);
    expect(invariants.get(child.address)).toEqual(child); // Returns exact match
  });

  it("should be iterable and include all claimed invariants", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

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

    const collected = [...invariants];
    expect(collected).toHaveLength(2);
    expect(collected).toContainEqual(alice);
    expect(collected).toContainEqual(bob);
  });

  it("should return deepest matching parent for nested queries", async () => {
    const history = new History();
    const identity = await Identity.fromPassphrase("read invariants test");
    const space = identity.did();
    const invariants = history.for(space);

    // Claim multiple invariants at different depths with CONSISTENT data
    const root = {
      address: {
        id: "user:1",
        type: "application/json",
        path: [],
      },
      value: {
        profile: { name: "Alice", settings: { theme: "light" } },
        other: "data",
      },
    } as const;

    const profile = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      },
      value: { name: "Alice", settings: { theme: "light" } }, // Must match root.profile
    } as const;

    const settings = {
      address: {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings"],
      },
      value: { theme: "light" }, // Must match root.profile.settings
    } as const;

    invariants.claim(root);
    invariants.claim(profile);
    invariants.claim(settings);

    // Query for deep nested path should return the deepest matching parent
    const deepQuery = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "settings", "theme"],
    } as const;

    const retrieved = invariants.get(deepQuery);
    expect(retrieved).toEqual(settings); // Settings is the deepest match

    // Query for path at profile level
    const profileQuery = {
      id: "user:1",
      type: "application/json",
      path: ["profile", "name"],
    } as const;

    expect(invariants.get(profileQuery)).toEqual(profile);

    // Query for path outside profile should return root
    const otherQuery = {
      id: "user:1",
      type: "application/json",
      path: ["other"],
    } as const;

    expect(invariants.get(otherQuery)).toEqual(root);
  });
});
