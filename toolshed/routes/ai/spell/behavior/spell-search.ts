import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { Spell, SpellSchema } from "../spell.ts";
import { Schema } from "jsonschema";

interface SpellSearchResult {
  spells: Array<{
    key: string;
    name: string;
    description: string;
    matchType: "reference" | "text-match";
    compatibleBlobs: Array<{
      key: string;
      snippet: string;
      data: unknown;
    }>;
  }>;
  blobs: Array<{
    key: string;
    snippet: string;
    matchType: "reference" | "text-match";
    compatibleSpells: Array<{
      key: string;
      name: string;
      description: string;
    }>;
  }>;
}

interface SpellSearchParams {
  query: string;
  tags?: string[];
  referencedKeys: string[];
  spells: Record<string, Record<string, unknown>>;
  blobs: Record<string, Record<string, unknown>>;
  options?: {
    limit?: number;
  };
}

function calculateRank(itemStr: string, tags: string[] = []): number {
  let rank = 0;
  const hashTags = tags.map((tag) => `#${tag.toLowerCase()}`);

  for (const tag of hashTags) {
    const matches =
      (itemStr.toLowerCase().match(new RegExp(tag, "g")) || []).length;
    rank += matches;
  }

  return rank;
}
export function processSpellSearch({
  query,
  tags = [],
  referencedKeys,
  spells,
  blobs,
  options = {},
}: SpellSearchParams): SpellSearchResult {
  try {
    const spellMatches: SpellSearchResult["spells"] = [];
    const blobMatches: SpellSearchResult["blobs"] = [];

    console.log(spells);

    // Parse spells using schema
    const validSpells: Record<string, Spell> = {};
    for (const [key, spell] of Object.entries(spells)) {
      try {
        const parsed = SpellSchema.parse(spell);
        validSpells[key] = parsed;
        console.log("checked spell", parsed);
      } catch (error: any) {
        console.log(`Invalid spell ${key}:`, error.message);
        continue;
      }
    }

    console.log("Valid spells:", Object.keys(validSpells));

    const limit = options.limit || 10;
    const searchTerms = query.toLowerCase().replace(/@\w+/g, "").trim();

    // Handle @references first
    for (const key of referencedKeys) {
      const spellKey = `spell-${key}`;
      const blobKey = key;

      // Check for referenced spells
      if (validSpells[spellKey]) {
        spellMatches.push({
          key: spellKey,
          name: validSpells[spellKey].spellbookTitle as string || spellKey,
          description:
            validSpells[spellKey].recipe.argumentSchema.description as string ||
            "No description",
          matchType: "reference",
          compatibleBlobs: findCompatibleBlobs(validSpells[spellKey], blobs),
        });
      }

      // Check for referenced blobs
      if (blobs[blobKey] && !blobKey.startsWith("spell-")) {
        blobMatches.push({
          key: blobKey,
          snippet: getRelevantSnippet(JSON.stringify(blobs[blobKey])),
          matchType: "reference",
          compatibleSpells: findCompatibleSpells(blobs[blobKey], validSpells),
        });
      }
    }

    // Perform text search if we haven't hit the limit
    if (searchTerms) {
      // Search spells with tags
      if (spellMatches.length < limit) {
        const textSpellMatches = searchSpells(
          searchTerms,
          validSpells,
          blobs,
          limit - spellMatches.length,
          tags,
        );
        spellMatches.push(...textSpellMatches);
      }

      // Search blobs with tags
      if (blobMatches.length < limit) {
        const textBlobMatches = searchBlobs(
          searchTerms,
          blobs,
          validSpells,
          limit - blobMatches.length,
          tags,
        );
        blobMatches.push(...textBlobMatches);
      }
    }

    return {
      spells: spellMatches.slice(0, limit),
      blobs: blobMatches.slice(0, limit),
    };
  } catch (error) {
    console.error("Error in processSpellSearch:", {
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      query,
      referencedKeys,
      spellKeys: Object.keys(spells),
      blobKeys: Object.keys(blobs),
    });
    return { spells: [], blobs: [] };
  }
}

function searchSpells(
  searchTerms: string,
  spells: Record<string, Spell>,
  blobs: Record<string, Record<string, unknown>>,
  limit: number,
  tags: string[] = [],
): SpellSearchResult["spells"] {
  const matches: Array<SpellSearchResult["spells"][0] & { rank: number }> = [];

  for (const [key, spell] of Object.entries(spells)) {
    const spellStr = JSON.stringify(spell).toLowerCase();
    if (spellStr.includes(searchTerms)) {
      const rank = calculateRank(spellStr, tags);
      matches.push({
        key,
        name: spell.spellbookTitle as string || key,
        description: spell.recipe.argumentSchema?.description as string ||
          "No description",
        matchType: "text-match" as const,
        compatibleBlobs: findCompatibleBlobs(spell, blobs),
        rank,
      });
    }
  }

  return matches
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank, ...rest }) => rest);
}

function searchBlobs(
  searchTerms: string,
  blobs: Record<string, Record<string, unknown>>,
  spells: Record<string, Spell>,
  limit: number,
  tags: string[] = [],
): SpellSearchResult["blobs"] {
  const matches: Array<SpellSearchResult["blobs"][0] & { rank: number }> = [];

  for (const [key, blob] of Object.entries(blobs)) {
    if (key.startsWith("spell-")) continue;

    const blobStr = JSON.stringify(blob).toLowerCase();
    if (blobStr.includes(searchTerms)) {
      const rank = calculateRank(blobStr, tags);
      matches.push({
        key,
        snippet: getRelevantSnippet(blobStr),
        matchType: "text-match" as const,
        compatibleSpells: findCompatibleSpells(blob, spells),
        rank,
      });
    }
  }

  return matches
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank, ...rest }) => rest);
}

export function findCompatibleSpells(
  blob: Record<string, unknown>,
  spells: Record<string, Spell>,
): Array<{ key: string; name: string; description: string }> {
  const compatible: Array<{ key: string; name: string; description: string }> =
    [];
  const blobStr = JSON.stringify(blob).toLowerCase();

  for (const [key, spell] of Object.entries(spells)) {
    const spellStr = JSON.stringify(spell).toLowerCase();
    if (
      checkSchemaMatch(blob, spell.recipe.argumentSchema.properties) ||
      spellStr.includes(blob.key?.toString().toLowerCase() || "")
    ) {
      compatible.push({
        key,
        name: spell.spellbookTitle as string || key,
        description: spell.recipe.argumentSchema.description as string ||
          "No description",
      });
    }
  }

  return compatible;
}

function findCompatibleBlobs(
  spell: Spell,
  blobs: Record<string, Record<string, unknown>>,
): Array<{ key: string; snippet: string; data: unknown }> {
  const compatible: Array<{ key: string; snippet: string; data: unknown }> = [];
  const spellStr = JSON.stringify(spell).toLowerCase();

  for (const [key, blob] of Object.entries(blobs)) {
    if (key.startsWith("spell-")) continue;

    const blobStr = JSON.stringify(blob).toLowerCase();
    if (
      checkSchemaMatch(blob, spell.recipe.argumentSchema.properties) ||
      spellStr.includes(key.toLowerCase())
    ) {
      compatible.push({
        key,
        snippet: getRelevantSnippet(blobStr),
        data: blob,
      });
    }
  }

  return compatible;
}

function getRelevantSnippet(str: string): string {
  // Return a shortened version of the string for display
  return str.length > 100 ? str.substring(0, 100) + "..." : str;
}

function hasMatchingSchema(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  // Look for common type/schema patterns
  return aStr.includes('"type":') && bStr.includes('"type":') &&
    (aStr.includes(bStr) || bStr.includes(aStr));
}
