/**
 * Tests CheckList: adding, toggling, removing, the counts, and that a
 * reference held across an edit still addresses its item.
 *
 * Run: deno task cf test packages/patterns/primitives/check-list.test.tsx
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import CheckList from "./check-list.tsx";

export default pattern(() => {
  const list = CheckList({});
  // The held-reference sequence from the primitives contract: stash an item,
  // mutate the list through the atom, then operate via the stashed reference.
  const held = new Writable<{ title: string; done: boolean; quantity: number }>(
    { title: "", done: false, quantity: 1 },
  );

  const addPassport = action(() => list.addItem.send({ title: "Passport" }));
  const addSocks = action(() =>
    list.addItem.send({ title: "Socks", quantity: 6 })
  );
  const addBlank = action(() => list.addItem.send({ title: "   " }));
  const stashFirst = action(() => held.set(list.items[0]));
  const toggleHeld = action(() => list.toggleItem.send({ item: held.get() }));
  const removeHeld = action(() => list.removeItem.send({ item: held.get() }));
  const clearCompleted = action(() => list.clearCompleted.send());

  return {
    [TESTS]: [
      { assertion: assert(() => list.items.length === 0) },
      { assertion: assert(() => list.remainingCount === 0) },

      { action: addPassport },
      { action: addSocks },
      { assertion: assert(() => list.items.length === 2) },
      { assertion: assert(() => list.remainingCount === 2) },
      { assertion: assert(() => list.completedCount === 0) },
      // A quantity the caller gave, and the default for one it did not.
      { assertion: assert(() => list.items[0].quantity === 1) },
      { assertion: assert(() => list.items[1].quantity === 6) },

      // An item with no title is not something anyone can tick off.
      { action: addBlank },
      { assertion: assert(() => list.items.length === 2) },

      { action: stashFirst },
      { action: toggleHeld },
      { assertion: assert(() => list.items[0].done === true) },
      { assertion: assert(() => list.remainingCount === 1) },
      { assertion: assert(() => list.completedCount === 1) },
      {
        assertion: assert(() => list.summary === "done: Passport, open: Socks"),
      },

      // Toggling writes through the element's cell rather than replacing the
      // slot, so the reference stashed before the edit still matches.
      { action: toggleHeld },
      { assertion: assert(() => list.items[0].done === false) },
      { action: toggleHeld },
      { assertion: assert(() => list.completedCount === 1) },

      { action: clearCompleted },
      { assertion: assert(() => list.items.length === 1) },
      { assertion: assert(() => list.items[0].title === "Socks") },

      { action: stashFirst },
      { action: removeHeld },
      { assertion: assert(() => list.items.length === 0) },
    ],
  };
});
