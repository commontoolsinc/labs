/// <cts-enable />
import { derive, recipe } from "commontools";

interface Preference {
  ingredient: string;
  preference: "liked" | "disliked";
}

export default recipe<{ preferences: Preference[]; foodDescription: string }>((state) => {
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
      return `Recipe for ${food} with: ${liked}`;
    }
  );

  return { wishQuery };
});
