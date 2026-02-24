/// <cts-enable />
import {
  computed,
  type Default,
  equals,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  UI,
  wish,
  Writable,
} from "commontools";
import { type MentionablePiece } from "./backlinks-index.tsx";

export type GraphEdge = {
  from: Writable<MentionablePiece>;
  to: Writable<MentionablePiece>;
  fromName: string;
  toName: string;
  description: string;
};

export type CompoundNode = {
  [NAME]: string;
  linkedPieces: Writable<MentionablePiece>[];
  summary: string;
};

type Input = Record<string, never>;

type Output = {
  edges: GraphEdge[];
  compoundNodes: CompoundNode[];
  findIncoming: PatternToolResult<{ edges: GraphEdge[] }>;
  findOutgoing: PatternToolResult<{ edges: GraphEdge[] }>;
  searchGraph: PatternToolResult<{
    edges: GraphEdge[];
    compoundNodes: CompoundNode[];
  }>;
};

/** Query result type for LLM consumption — names for readability, refs for identity. */
type EdgeResult = {
  from: Writable<MentionablePiece>;
  to: Writable<MentionablePiece>;
  fromName: string;
  toName: string;
  description: string;
};

/** Query sub-pattern: finds incoming edges to an entity. */
export const findIncomingPattern = pattern<
  { entity: Writable<MentionablePiece>; edges: GraphEdge[] },
  { result: EdgeResult[] }
>(({ entity, edges }) => {
  const result = computed(() => {
    return edges
      .filter((edge) => equals(edge.to, entity))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        fromName: edge.fromName,
        toName: edge.toName,
        description: edge.description,
      }));
  });

  return { result };
});

/** Query sub-pattern: finds outgoing edges from an entity. */
export const findOutgoingPattern = pattern<
  { entity: Writable<MentionablePiece>; edges: GraphEdge[] },
  { result: EdgeResult[] }
>(({ entity, edges }) => {
  const result = computed(() => {
    return edges
      .filter((edge) => equals(edge.from, entity))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        fromName: edge.fromName,
        toName: edge.toName,
        description: edge.description,
      }));
  });

  return { result };
});

/** Query sub-pattern: searches graph by text query. */
export const searchGraphPattern = pattern<
  { query: string; edges: GraphEdge[]; compoundNodes: CompoundNode[] },
  { edges: EdgeResult[]; compoundNodes: CompoundNode[] }
>(({ query, edges, compoundNodes }) => {
  const filteredEdges = computed(() => {
    const matching = !query || query.trim() === "" ? edges : (() => {
      const lowerQuery = query.toLowerCase().trim();
      return edges.filter((edge) =>
        edge.fromName.toLowerCase().includes(lowerQuery) ||
        edge.toName.toLowerCase().includes(lowerQuery) ||
        edge.description.toLowerCase().includes(lowerQuery)
      );
    })();
    return matching.map((edge) => ({
      from: edge.from,
      to: edge.to,
      fromName: edge.fromName,
      toName: edge.toName,
      description: edge.description,
    }));
  });

  const filteredNodes = computed(() => {
    if (!query || query.trim() === "") return compoundNodes;
    const lowerQuery = query.toLowerCase().trim();
    return compoundNodes.filter((node) => {
      const name = (node[NAME] ?? "").toString().toLowerCase();
      const summary = node.summary.toLowerCase();
      return name.includes(lowerQuery) || summary.includes(lowerQuery);
    });
  });

  return { edges: filteredEdges, compoundNodes: filteredNodes };
});

const KnowledgeGraph = pattern<Input, Output>(() => {
  const mentionable = wish<Default<Writable<MentionablePiece>[], []>>({
    query: "#mentionable",
  }).result;

  const baseEdges = computed(() => {
    const result: GraphEdge[] = [];
    for (const piece of mentionable ?? []) {
      if (!piece) continue;
      const pieceName = (piece.get()[NAME] ?? "").toString();
      // Access mentioned via .key() for reactive tracking
      const mentioned = piece.key("mentioned").get() ?? [];
      for (const mentionedItem of mentioned) {
        if (!mentionedItem) continue;
        const mentionedName = (mentionedItem[NAME] ?? "").toString();
        result.push({
          from: piece,
          to: mentionedItem as Writable<MentionablePiece>,
          fromName: pieceName,
          toName: mentionedName,
          description: "mentions",
        });
      }
    }
    return result;
  });

  const agentEdges = Writable.of<GraphEdge[]>([]);
  const compoundNodes = Writable.of<CompoundNode[]>([]);

  const allEdges = computed(() => [...baseEdges, ...agentEdges.get()]);

  const edgeCount = computed(() => allEdges.length);

  return {
    [NAME]: computed(() => `Knowledge Graph (${edgeCount} links)`),
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Knowledge Graph</h2>
        </ct-toolbar>
        <ct-vstack gap="4" padding="6">
          <span
            style={{
              fontSize: "13px",
              color: "var(--ct-color-text-secondary)",
            }}
          >
            {edgeCount} links
          </span>
          <ct-table full-width>
            <tbody>
              {allEdges.map((edge) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <ct-cell-link $cell={edge.from} />
                  </td>
                  <td
                    style={{
                      fontSize: "13px",
                      color: "var(--ct-color-text-secondary)",
                      textAlign: "center",
                    }}
                  >
                    {edge.description}
                  </td>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <ct-cell-link $cell={edge.to} />
                  </td>
                </tr>
              ))}
            </tbody>
          </ct-table>
        </ct-vstack>
      </ct-screen>
    ),
    edges: allEdges,
    compoundNodes,
    findIncoming: patternTool(findIncomingPattern, { edges: allEdges }),
    findOutgoing: patternTool(findOutgoingPattern, { edges: allEdges }),
    searchGraph: patternTool(searchGraphPattern, {
      edges: allEdges,
      compoundNodes,
    }),
  };
});

export default KnowledgeGraph;
