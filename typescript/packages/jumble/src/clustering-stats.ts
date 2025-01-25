import { calculateSimilarity, Cluster, Token } from "./clustering-utils";

export type ClusterStats = {
  clusterId: string
  itemCount: number
  commonTokens: { value: string; count: number }[]
  density: number // How tightly clustered
  averageSimilarity: number
}

export const calculateClusterStats = (
  cluster: Cluster,
  items: Blob[],
  itemTokens: Map<string, Token[]>
): ClusterStats => {
  // Get all tokens in cluster
  const tokenCounts = new Map<string, number>()
  cluster.items.forEach(itemId => {
    const tokens = itemTokens.get(itemId) || []
    tokens.forEach(token => {
      tokenCounts.set(token.value, (tokenCounts.get(token.value) || 0) + 1)
    })
  })

  // Calculate average similarity between all items in cluster
  let totalSimilarity = 0
  let comparisons = 0
  for (let i = 0; i < cluster.items.length; i++) {
    for (let j = i + 1; j < cluster.items.length; j++) {
      const tokensA = itemTokens.get(cluster.items[i]) || []
      const tokensB = itemTokens.get(cluster.items[j]) || []
      totalSimilarity += calculateSimilarity(tokensA, tokensB)
      comparisons++
    }
  }

  return {
    clusterId: cluster.id,
    itemCount: cluster.items.length,
    commonTokens: Array.from(tokenCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count })),
    density: calculateClusterDensity(cluster, items),
    averageSimilarity: comparisons > 0 ? totalSimilarity / comparisons : 0
  }
}

const calculateClusterDensity = (cluster: Cluster, items: Blob[]): number => {
  const clusterItems = items.filter(item => cluster.items.includes(item.id))

  if (clusterItems.length < 2) return 1

  // Calculate bounding box
  const positions = clusterItems.map(item => ({ x: item.x, y: item.y }))
  const minX = Math.min(...positions.map(p => p.x))
  const maxX = Math.max(...positions.map(p => p.x))
  const minY = Math.min(...positions.map(p => p.y))
  const maxY = Math.max(...positions.map(p => p.y))

  // Calculate area and ideal area
  const actualArea = (maxX - minX + CARD_WIDTH) * (maxY - minY + CARD_HEIGHT)
  const itemArea = CARD_WIDTH * CARD_HEIGHT
  const minPossibleArea = itemArea * clusterItems.length

  // Calculate average distance between items
  let totalDistance = 0
  let comparisons = 0

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      totalDistance += Math.sqrt(
        Math.pow(positions[i].x - positions[j].x, 2) +
        Math.pow(positions[i].y - positions[j].y, 2)
      )
      comparisons++
    }
  }

  const avgDistance = totalDistance / comparisons
  const minPossibleDistance = Math.sqrt(itemArea)

  // Combine area and distance metrics
  const areaDensity = minPossibleArea / actualArea
  const distanceDensity = minPossibleDistance / avgDistance

  // Return normalized density score (0 to 1)
  return Math.min(Math.max((areaDensity + distanceDensity) / 2, 0), 1)
}
