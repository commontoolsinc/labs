/// <cts-enable />
import { computed, pattern } from "commontools";

interface Preference {
  ingredient: string;
  preference: "liked" | "disliked";
}

export default pattern<{ preferences: Preference[] }>((state) => {
  // Inside computed(), OpaqueRef auto-unwraps to plain array.
  // .filter() and .map() should NOT be transformed to *WithPattern.
  const liked = computed(() => {
    return state.preferences
      .filter((p) => p.preference === "liked")
      .map((p) => p.ingredient);
  });

  return { liked };
});
