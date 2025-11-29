/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  generateObject,
  handler,
  NAME,
  pattern,
  str,
  UI,
} from "commontools";

/**
 * Article Analyzer - Demonstrates reduce() and keyed map() primitives
 *
 * This pattern showcases:
 * - Keyed map(): Process articles by URL (no duplicate analysis when reordering)
 * - reduce(): Aggregate completed analyses and collect stats
 *
 * Add article titles, and each gets analyzed with generateObject. The results
 * are aggregated in real-time using reduce() to show progress and insights.
 */

interface ArticleAnalysis {
  summary: string;
  keyPoints: string[];
  sentiment: "positive" | "neutral" | "negative";
  topics: string[];
}

interface State {
  articles: Default<string[], [
    "Climate Change Report 2024",
    "AI Breakthroughs This Year",
    "Mars Mission Updates"
  ]>;
  newArticle: Cell<string>;
}

const addArticle = handler<
  unknown,
  { articles: Cell<string[]>; newArticle: Cell<string> }
>((_, { articles, newArticle }) => {
  const title = newArticle.get().trim();
  if (title) {
    articles.push(title);
    newArticle.set("");
  }
});

const removeArticle = handler<
  unknown,
  { title: string; articles: Cell<string[]> }
>((_, { title, articles }) => {
  const current = articles.get();
  const index = current.indexOf(title);
  if (index >= 0) {
    articles.set(current.toSpliced(index, 1));
  }
});

export default pattern<State>(({ articles, newArticle }) => {
  // Keyed map: Each article is analyzed by title - reordering won't re-analyze
  // Since articles are strings, the string itself is the key
  // We return both the title and analysis together
  const analysisItems = articles.map(
    (title) => ({
      title,
      analysis: generateObject<ArticleAnalysis>({
        prompt: str`Analyze an article titled "${title}".
          Since this is a demo, create a plausible fictional analysis.`,
        system: `You are an article analyzer. Generate a realistic analysis with:
          - A 2-3 sentence summary
          - 3-5 key points as bullet points
          - Overall sentiment (positive/neutral/negative)
          - 2-4 relevant topics/tags`,
      }),
    }),
    { key: "." } // Use the string value itself as the key
  );

  // reduce(): Count completed analyses
  const completedCount = analysisItems.reduce(
    0,
    (acc: number, item) => acc + (item.analysis.pending ? 0 : 1)
  );

  // reduce(): Count positive sentiment analyses
  const positiveCount = analysisItems.reduce(
    0,
    (acc: number, item) => {
      if (item.analysis.pending || item.analysis.error || !item.analysis.result) return acc;
      return acc + (item.analysis.result.sentiment === "positive" ? 1 : 0);
    }
  );

  // reduce(): Collect all unique topics from completed analyses
  const allTopics = analysisItems.reduce(
    [] as string[],
    (acc: string[], item) => {
      if (item.analysis.pending || item.analysis.error || !item.analysis.result) return acc;
      // Add topics that aren't already in the list
      const newTopics = item.analysis.result.topics.filter(t => !acc.includes(t));
      return [...acc, ...newTopics];
    }
  );

  // reduce(): Count total key points across all analyses
  const totalKeyPoints = analysisItems.reduce(
    0,
    (acc: number, item) => {
      if (item.analysis.pending || item.analysis.error || !item.analysis.result) return acc;
      return acc + item.analysis.result.keyPoints.length;
    }
  );

  const totalArticles = computed(() => articles.length);

  return {
    [NAME]: str`Article Analyzer (${completedCount}/${totalArticles})`,
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "800px", margin: "0 auto" }}>
        <h1>Article Analyzer</h1>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          Demonstrates <code>reduce()</code> and keyed <code>map()</code> primitives
        </p>

        {/* Aggregated Stats (from reduce) */}
        <div style={{
          background: "#e3f2fd",
          padding: "1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "1rem"
        }}>
          <div>
            <div style={{ fontSize: "2rem", fontWeight: "bold" }}>
              {completedCount}/{totalArticles}
            </div>
            <div style={{ color: "#666" }}>Analyzed</div>
          </div>
          <div>
            <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#4caf50" }}>
              {positiveCount}
            </div>
            <div style={{ color: "#666" }}>Positive</div>
          </div>
          <div>
            <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#2196f3" }}>
              {totalKeyPoints}
            </div>
            <div style={{ color: "#666" }}>Key Points</div>
          </div>
          <div>
            <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#9c27b0" }}>
              {computed(() => allTopics.length)}
            </div>
            <div style={{ color: "#666" }}>Topics</div>
          </div>
        </div>

        {/* Topics Cloud */}
        <div style={{ marginBottom: "1rem" }}>
          <strong>All Topics: </strong>
          {computed(() => allTopics.length > 0 ? allTopics.join(", ") : "Analyzing...")}
        </div>

        {/* Add Article Form */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <ct-input
            $value={newArticle}
            placeholder="Enter article title..."
            style={{ flex: "1" }}
          />
          <ct-button onClick={addArticle({ articles, newArticle })}>
            Add Article
          </ct-button>
        </div>

        {/* Article List with Analyses */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {analysisItems.map((item) => (
            <div style={{
              border: "1px solid #ddd",
              borderRadius: "8px",
              padding: "1rem",
              background: item.analysis.pending ? "#fffbf0" : "#fff"
            }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: "0.5rem"
              }}>
                <h3 style={{ margin: 0 }}>{item.title}</h3>
              </div>

              {item.analysis.pending ? (
                <div style={{ color: "#ff9800" }}>⏳ Analyzing...</div>
              ) : item.analysis.error ? (
                <div style={{ color: "#f44336" }}>❌ Error: {item.analysis.error}</div>
              ) : item.analysis.result ? (
                <div>
                  <p><strong>Summary:</strong> {item.analysis.result.summary}</p>
                  <div>
                    <strong>Key Points:</strong>
                    <ul style={{ margin: "0.5rem 0", paddingLeft: "1.5rem" }}>
                      {item.analysis.result.keyPoints.map((point) => (
                        <li>{point}</li>
                      ))}
                    </ul>
                  </div>
                  <p>
                    <strong>Sentiment: </strong>
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      background: item.analysis.result.sentiment === "positive" ? "#c8e6c9"
                        : item.analysis.result.sentiment === "negative" ? "#ffcdd2"
                        : "#e0e0e0"
                    }}>
                      {item.analysis.result.sentiment}
                    </span>
                  </p>
                  <p><strong>Topics:</strong> {item.analysis.result.topics.join(", ")}</p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    ),
    articles,
    analysisItems,
    completedCount,
    positiveCount,
    allTopics,
    totalKeyPoints,
  };
});
