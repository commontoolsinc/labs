/// <cts-enable />
import { computed, generateObject, pattern } from "commonfabric";

// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObject(...) uses the synthesized __cf_destructure_* binding consistently
export default pattern<{ messages: string[] }>(({ messages }) => {
  const preview = computed(() => messages[0] ?? "");
  const { result } = generateObject({
    prompt: preview,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  });
  return <div>{result?.title ?? "Untitled"}</div>;
});
