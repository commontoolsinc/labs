import {
  computed,
  generateObjectStream,
  pattern,
  resultOf,
} from "commonfabric";

// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObjectStream(...) uses the synthesized
//   __cf_destructure_* binding consistently before resultOf() projects it.
export default pattern<{ messages: string[] }>(({ messages }) => {
  const preview = computed(() => messages[0] ?? "");
  const { result: request } = generateObjectStream({
    prompt: preview,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  });
  const result = resultOf(request);
  return <div>{result?.title ?? "Untitled"}</div>;
});
