import {
  generateObject,
  JSONSchema,
  pattern,
  Reactive,
  resultOf,
} from "commonfabric";

interface Email {
  id: string;
  content: string;
}

interface ExtractedData {
  summary: string;
}

// Generic building block - T is a type parameter
function BuildingBlock<T>(emails: Reactive<Email[]>, schema: JSONSchema) {
  // This is the problematic case: generateObject<T> where T is a type parameter
  // resultOf preserves the unresolved T while filtering unavailable states.
  const analyses = emails.map((email: Email) => {
    const request = generateObject<T>({
      prompt: email.content,
      schema,
    });
    const result = resultOf(request);

    return {
      email,
      request,
      result,
    };
  });

  return { analyses };
}

// Pattern that uses the building block
export default pattern(({ emails }: { emails: Reactive<Email[]> }) => {
  const data = BuildingBlock<ExtractedData>(emails, { type: "object" });
  return { data };
});
