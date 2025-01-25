// clustering-utils.ts
export type Token = {
  type: "word" | "hashtag";
  value: string;
  weight: number;
};

export const extractTokens = (blob: any): Token[] => {
  // Convert blob data to string and extract meaningful tokens
  const text = JSON.stringify(blob).toLowerCase();

  // Extract hashtags with higher weight
  const hashtagPattern = /#[\w-]+/g;
  const hashtags = [...text.matchAll(hashtagPattern)].map(match => ({
    type: "hashtag" as const,
    value: match[0],
    weight: 2.0, // Hashtags are weighted more heavily
  }));

  // Extract significant words (excluding common words)
  const commonWords = new Set([
    "the",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
  ]);
  const wordPattern = /\b\w{3,}\b/g;
  const words = [...text.matchAll(wordPattern)]
    .map(match => match[0])
    .filter(word => !commonWords.has(word))
    .map(word => ({
      type: "word" as const,
      value: word,
      weight: 1.0,
    }));

  return [...hashtags, ...words];
};

export const calculateSimilarity = (
  tokensA: Token[],
  tokensB: Token[],
): number => {
  const setA = new Set(tokensA.map(t => t.value));
  const setB = new Set(tokensB.map(t => t.value));

  let similarityScore = 0;

  // Calculate intersection
  for (const token of tokensA) {
    if (setB.has(token.value)) {
      similarityScore += token.weight;
    }
  }

  // Normalize by total possible similarity
  const totalPossible = Math.max(
    tokensA.reduce((sum, t) => sum + t.weight, 0),
    tokensB.reduce((sum, t) => sum + t.weight, 0),
  );

  return similarityScore / totalPossible;
};

export type Cluster = {
  id: string;
  items: string[]; // item ids
  centerX: number;
  centerY: number;
  tokens: Token[];
};

export const createClusters = (
  items: Blob[],
  similarityThreshold: number = 0.3,
): Cluster[] => {
  // Extract tokens for all items
  const itemTokens = new Map(
    items.map(item => [item.id, extractTokens(item.data)]),
  );

  // Track which items have been clustered
  const clusteredItems = new Set<string>();
  const clusters: Cluster[] = [];

  // Try to cluster each unclustered item
  for (const item of items) {
    if (clusteredItems.has(item.id)) continue;

    const cluster: Cluster = {
      id: `cluster-${clusters.length}`,
      items: [item.id],
      centerX: item.x,
      centerY: item.y,
      tokens: itemTokens.get(item.id) || [],
    };

    // Find similar items
    for (const otherItem of items) {
      if (otherItem.id === item.id || clusteredItems.has(otherItem.id))
        continue;

      const similarity = calculateSimilarity(
        itemTokens.get(item.id) || [],
        itemTokens.get(otherItem.id) || [],
      );

      if (similarity >= similarityThreshold) {
        cluster.items.push(otherItem.id);
        clusteredItems.add(otherItem.id);
      }
    }

    clusteredItems.add(item.id);
    clusters.push(cluster);
  }

  return clusters;
};
