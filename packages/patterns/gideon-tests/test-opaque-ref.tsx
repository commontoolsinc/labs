/// <cts-enable />
import { pattern, generateObject, OpaqueRef, JSONSchema } from "commontools";

interface Email {
  id: string;
  content: string;
}

interface ExtractedData {
  summary: string;
}

// Generic building block - T is a type parameter
function BuildingBlock<T>(emails: OpaqueRef<Email[]>, schema: JSONSchema) {
  // This is the problematic case: generateObject<T> where T is a type parameter
  // The result is OpaqueRef<T | undefined> where T is unresolved
  const analyses = emails.map((email: Email) => {
    const analysis = generateObject<T>({
      prompt: email.content,
      schema,
    });

    return {
      email,
      analysis,
      result: analysis.result, // OpaqueRef<T | undefined> - T is a type parameter!
    };
  });

  return { analyses };
}

// Pattern that uses the building block
export default pattern(({ emails }: { emails: OpaqueRef<Email[]> }) => {
  const data = BuildingBlock<ExtractedData>(emails, { type: "object" });
  return { data };
});
