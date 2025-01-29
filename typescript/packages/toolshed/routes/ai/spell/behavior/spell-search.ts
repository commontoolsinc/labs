interface SpellSearchResult {
  spells: Array<{
    key: string;
    name: string;
    description: string;
    matchType: "reference" | "text-match";
    compatibleBlobs: Array<{
      key: string;
      snippet: string;
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
  referencedKeys: string[];
  spells: Record<string, Record<string, unknown>>;
  blobs: Record<string, Record<string, unknown>>;
  options?: {
    limit?: number;
  };
}

export function processSpellSearch({
  query,
  referencedKeys,
  spells,
  blobs,
  options = {},
}: SpellSearchParams): Promise<SpellSearchResult> {
  const spellMatches: SpellSearchResult["spells"] = [];
  const blobMatches: SpellSearchResult["blobs"] = [];

  const limit = options.limit || 10;
  const searchTerms = query.toLowerCase().replace(/@\w+/g, "").trim();

  // Handle @references first
  for (const key of referencedKeys) {
    const spellKey = `spell-${key}`;
    const blobKey = key;

    // Check for referenced spells
    if (spells[spellKey]) {
      spellMatches.push({
        key: spellKey,
        name: spells[spellKey].name as string || spellKey,
        description: spells[spellKey].description as string || "No description",
        matchType: "reference",
        compatibleBlobs: findCompatibleBlobs(spells[spellKey], blobs),
      });
    }

    // Check for referenced blobs
    if (blobs[blobKey] && !blobKey.startsWith("spell-")) {
      blobMatches.push({
        key: blobKey,
        snippet: getRelevantSnippet(JSON.stringify(blobs[blobKey])),
        matchType: "reference",
        compatibleSpells: findCompatibleSpells(blobs[blobKey], spells),
      });
    }
  }

  // Perform text search if we haven't hit the limit
  if (searchTerms) {
    // Search spells
    if (spellMatches.length < limit) {
      const textSpellMatches = searchSpells(
        searchTerms,
        spells,
        blobs,
        limit - spellMatches.length,
      );
      spellMatches.push(...textSpellMatches);
    }

    // Search blobs
    if (blobMatches.length < limit) {
      const textBlobMatches = searchBlobs(
        searchTerms,
        blobs,
        spells,
        limit - blobMatches.length,
      );
      blobMatches.push(...textBlobMatches);
    }
  }

  return {
    spells: spellMatches.slice(0, limit),
    blobs: blobMatches.slice(0, limit),
  };
}

function searchSpells(
  searchTerms: string,
  spells: Record<string, Record<string, unknown>>,
  blobs: Record<string, Record<string, unknown>>,
  limit: number,
): SpellSearchResult["spells"] {
  const matches = [];

  for (const [key, spell] of Object.entries(spells)) {
    const spellStr = JSON.stringify(spell).toLowerCase();
    if (spellStr.includes(searchTerms)) {
      matches.push({
        key,
        name: spell.name as string || key,
        description: spell.description as string || "No description",
        matchType: "text-match" as const,
        compatibleBlobs: findCompatibleBlobs(spell, blobs),
      });
    }

    if (matches.length >= limit) break;
  }

  return matches;
}

function searchBlobs(
  searchTerms: string,
  blobs: Record<string, Record<string, unknown>>,
  spells: Record<string, Record<string, unknown>>,
  limit: number,
): SpellSearchResult["blobs"] {
  const matches = [];

  for (const [key, blob] of Object.entries(blobs)) {
    if (key.startsWith("spell-")) continue; // Skip spells in blob search

    const blobStr = JSON.stringify(blob).toLowerCase();
    if (blobStr.includes(searchTerms)) {
      matches.push({
        key,
        snippet: getRelevantSnippet(blobStr),
        matchType: "text-match" as const,
        compatibleSpells: findCompatibleSpells(blob, spells),
      });
    }

    if (matches.length >= limit) break;
  }

  return matches;
}

function findCompatibleSpells(
  blob: Record<string, unknown>,
  spells: Record<string, Record<string, unknown>>,
): Array<{ key: string; name: string; description: string }> {
  const compatible = [];
  const blobStr = JSON.stringify(blob).toLowerCase();

  for (const [key, spell] of Object.entries(spells)) {
    const spellStr = JSON.stringify(spell).toLowerCase();
    if (
      hasMatchingSchema(spell, blob) ||
      spellStr.includes(blob.key?.toString().toLowerCase() || "")
    ) {
      compatible.push({
        key,
        name: spell.name as string || key,
        description: spell.description as string || "No description",
      });
    }
  }

  return compatible;
}

function findCompatibleBlobs(
  spell: Record<string, unknown>,
  blobs: Record<string, Record<string, unknown>>,
): Array<{ key: string; snippet: string }> {
  const compatible = [];
  const spellStr = JSON.stringify(spell).toLowerCase();

  for (const [key, blob] of Object.entries(blobs)) {
    if (key.startsWith("spell-")) continue;

    const blobStr = JSON.stringify(blob).toLowerCase();
    if (
      hasMatchingSchema(spell, blob) ||
      spellStr.includes(key.toLowerCase())
    ) {
      compatible.push({
        key,
        snippet: getRelevantSnippet(blobStr),
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
