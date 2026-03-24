/// <cts-enable />
import { derive, pattern } from "commonfabric";

interface Preference {
  ingredient: string;
  preference: "liked" | "disliked";
}

// FIXTURE: derive-filter-map-chain
// Verifies: .filter() and .map() inside a derive callback are NOT transformed to reactive versions
//   .filter(fn) stays as .filter(fn) (not .filterWithPattern)
//   .map(fn) stays as .map(fn) (not .mapWithPattern)
// Context: inside derive, `prefs` is unwrapped to a plain array; plain array methods should not be rewritten
export default pattern<{ preferences: Preference[]; foodDescription: string }>((state) => {
  // Using object input form for derive - exactly like the issue describes
  // This matches: derive({ foodDescription, preferences }, ({ foodDescription: food, preferences: prefs }) => ...)
  const wishQuery = derive(
    { food: state.foodDescription, prefs: state.preferences },
    ({ food, prefs }) => {
      // Filter-map chain inside derive callback
      // The .map() should NOT be transformed to .mapWithPattern() because:
      // - Inside derive, `prefs` is unwrapped to a plain array
      // - .filter() returns a plain JS array
      // - Plain arrays don't have .mapWithPattern()
      const liked = prefs
        .filter((p) => p.preference === "liked")
        .map((p) => p.ingredient)
        .join(", ");
      return `Pattern for ${food} with: ${liked}`;
    }
  );

  return { wishQuery };
});
