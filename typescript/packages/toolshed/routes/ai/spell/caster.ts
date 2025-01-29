import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { isObject } from "@/routes/ai/spell/schema.ts";

export interface SchemaCandidate {
  key: string;
  similarity: number;
}

export function candidates(
  schema: Record<string, unknown>,
  blobContents: Record<string, Record<string, unknown>>,
): SchemaCandidate[] {
  const candidates: SchemaCandidate[] = [];

  // Iterate through all blobs
  for (const [key, blobData] of Object.entries(blobContents)) {
    try {
      // Check if the entire blob matches the schema
      if (checkSchemaMatch(blobData, schema)) {
        candidates.push({
          key,
          similarity: 1.0, // Exact match
        });
        continue;
      }

      // Look for matching objects at the root level of arrays
      if (Array.isArray(blobData)) {
        const hasMatchingItems = blobData.some((item) =>
          isObject(item) &&
          checkSchemaMatch(item as Record<string, unknown>, schema)
        );
        if (hasMatchingItems) {
          candidates.push({
            key,
            similarity: 1.0,
          });
          continue;
        }
      }

      // Check immediate properties for matching objects
      for (const value of Object.values(blobData)) {
        if (
          isObject(value) &&
          checkSchemaMatch(value as Record<string, unknown>, schema)
        ) {
          candidates.push({
            key,
            similarity: 0.9, // Slightly lower similarity for nested matches
          });
          break;
        }

        if (Array.isArray(value)) {
          const hasMatchingItems = value.some((item) =>
            isObject(item) &&
            checkSchemaMatch(item as Record<string, unknown>, schema)
          );
          if (hasMatchingItems) {
            candidates.push({
              key,
              similarity: 0.9,
            });
            break;
          }
        }
      }
    } catch (error) {
      // Skip blobs that cause errors during matching
      continue;
    }
  }

  // Sort by similarity descending
  return candidates.sort((a, b) => b.similarity - a.similarity);
}
