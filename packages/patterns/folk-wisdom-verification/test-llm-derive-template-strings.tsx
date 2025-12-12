/// <cts-enable />
/**
 * TEST PATTERN: Template Strings Require derive()
 *
 * CLAIM: Template strings with multiple properties need derive() wrapper
 * SOURCE: folk_wisdom/llm.md - "When to Use derive() for generateObject Prompts"
 *
 * WHAT THIS TESTS:
 * - That derive() wrapper enables template strings with OpaqueRef properties
 * - The broken approach (direct template strings) fails at compile time
 *
 * BROKEN APPROACH (does not compile):
 * ```tsx
 * const summaries = articles.map((article) => ({
 *   summary: generateObject<Summary>({
 *     prompt: `Title: ${article.title}\nContent: ${article.content}`,  // ERROR!
 *   }),
 * }));
 * ```
 * This fails with: "Tried to directly access an opaque value"
 * Because JavaScript evaluates ${article.title} IMMEDIATELY, but article is OpaqueRef.
 *
 * WORKING APPROACH (this pattern):
 * ```tsx
 * const summaries = articles.map((article) => ({
 *   summary: generateObject<Summary>({
 *     prompt: derive(article, (a) => `Title: ${a.title}\nContent: ${a.content}`),
 *   }),
 * }));
 * ```
 * derive() defers evaluation until reactive context is established.
 */
import {
  Cell,
  Default,
  derive,
  generateObject,
  handler,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Article {
  title: string;
  content: string;
}

interface Summary {
  mainPoints: string[];
  sentiment: string;
}

interface Input {
  articles: Default<Article[], []>;
}

const addArticle = handler<
  { detail: { message: string } },
  { articles: Cell<Article[]> }
>(
  ({ detail }, { articles }) => {
    const text = detail?.message?.trim();
    if (!text) return;

    // Parse as "Title | Content"
    const parts = text.split("|");
    const title = parts[0]?.trim() || "Untitled";
    const content = parts[1]?.trim() || text;

    articles.push({ title, content });
  },
);

const clearArticles = handler<unknown, { articles: Cell<Article[]> }>(
  (_, { articles }) => {
    articles.set([]);
  },
);

export default pattern<Input>(({ articles }) => {
  // WORKING: derive() wrapper defers template evaluation
  // Framework tracks dependencies, evaluates inside reactive context
  const summaries = articles.map((article) => ({
    article,
    summary: generateObject<Summary>({
      system:
        "Summarize the article. Return main points and overall sentiment.",
      // derive() defers template evaluation until reactive context
      prompt: derive(article, (a) => {
        if (!a) return "";
        return `Title: ${a.title}\n\nContent: ${a.content}`;
      }),
      model: "anthropic:claude-sonnet-4-5",
    }),
  }));

  return {
    [NAME]: "Test: Template Strings Need derive()",
    [UI]: (
      <div
        style={{ padding: "20px", maxWidth: "800px", fontFamily: "system-ui" }}
      >
        <h2>Template Strings Require derive()</h2>

        <div
          style={{
            padding: "15px",
            background: "#fff3e0",
            borderRadius: "6px",
            marginBottom: "20px",
          }}
        >
          <strong>Folk Wisdom Claim:</strong>{" "}
          Template strings accessing multiple OpaqueRef properties need a
          derive() wrapper.
        </div>

        {/* Broken code example (documentation only) */}
        <div
          style={{
            border: "2px solid #f44336",
            borderRadius: "6px",
            padding: "15px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ color: "#f44336", marginTop: 0 }}>
            BROKEN (fails to compile)
          </h3>
          <pre
            style={{
              background: "#ffebee",
              padding: "10px",
              borderRadius: "4px",
              overflow: "auto",
              fontSize: "12px",
            }}
          >
{`// This code fails at compile time:
const summaries = articles.map((article) => ({
  summary: generateObject<Summary>({
    prompt: \`Title: \${article.title}\\nContent: \${article.content}\`,
  }),
}));

// Error: "Tried to directly access an opaque value"`}
          </pre>
          <p style={{ fontSize: "13px", color: "#666", margin: "10px 0 0 0" }}>
            JavaScript evaluates <code>${`{article.title}`}</code>{" "}
            immediately, but <code>article</code>{" "}
            is an OpaqueRef that requires reactive context.
          </p>
        </div>

        {/* Working code example */}
        <div
          style={{
            border: "2px solid #4CAF50",
            borderRadius: "6px",
            padding: "15px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ color: "#4CAF50", marginTop: 0 }}>
            WORKING (this pattern)
          </h3>
          <pre
            style={{
              background: "#e8f5e9",
              padding: "10px",
              borderRadius: "4px",
              overflow: "auto",
              fontSize: "12px",
            }}
          >
{`// This code works:
const summaries = articles.map((article) => ({
  summary: generateObject<Summary>({
    prompt: derive(article, (a) =>
      \`Title: \${a.title}\\nContent: \${a.content}\`
    ),
  }),
}));`}
          </pre>
          <p style={{ fontSize: "13px", color: "#666", margin: "10px 0 0 0" }}>
            <code>derive()</code>{" "}
            defers template evaluation until reactive context is established.
          </p>
        </div>

        <div style={{ margin: "20px 0" }}>
          <ct-message-input
            placeholder="Add article: Title | Content (e.g., 'React Tips | Hooks simplify state')"
            appearance="rounded"
            onct-send={addArticle({ articles })}
          />
        </div>

        <div style={{ marginBottom: "10px" }}>
          <ct-button onClick={clearArticles({ articles })}>
            Clear Articles
          </ct-button>
          <span style={{ marginLeft: "10px", color: "#666" }}>
            {derive({ articles }, ({ articles: arr }) =>
              `${arr.length} article(s)`)}
          </span>
        </div>

        {/* Live results */}
        <div style={{ marginTop: "20px" }}>
          <h3>Live Results (using derive() approach):</h3>
          {summaries.map((item, idx) => (
            <div
              key={idx}
              style={{
                margin: "10px 0",
                padding: "15px",
                background: "#f5f5f5",
                borderRadius: "6px",
              }}
            >
              <div style={{ fontWeight: "bold", marginBottom: "10px" }}>
                {item.article.title}
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "#666",
                  marginBottom: "10px",
                }}
              >
                {item.article.content}
              </div>
              {derive(
                [item.summary.pending, item.summary.result, item.summary.error],
                ([pending, result, error]) => {
                  if (pending) {
                    return (
                      <div style={{ color: "#1976d2" }}>
                        <ct-loader show-elapsed /> Generating summary...
                      </div>
                    );
                  }
                  if (error) {
                    return (
                      <div style={{ color: "#d32f2f", fontSize: "13px" }}>
                        <strong>Error:</strong> {String(error)}
                      </div>
                    );
                  }
                  const summaryResult = result as Summary | undefined;
                  if (summaryResult) {
                    return (
                      <div style={{ fontSize: "13px" }}>
                        <div style={{ marginBottom: "8px" }}>
                          <strong>Main Points:</strong>
                          <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
                            {summaryResult.mainPoints.map((
                              point: string,
                              i: number,
                            ) => <li key={i}>{point}</li>)}
                          </ul>
                        </div>
                        <div>
                          <strong>Sentiment:</strong> {summaryResult.sentiment}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div style={{ color: "#666" }}>Waiting for input...</div>
                  );
                },
              )}
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: "30px",
            padding: "15px",
            background: "#e3f2fd",
            borderRadius: "6px",
          }}
        >
          <h4 style={{ marginTop: 0 }}>Why derive() Is Needed:</h4>
          <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8 }}>
            <li>
              JavaScript evaluates template strings <strong>immediately</strong>
            </li>
            <li>
              <code>`$&#123;article.title&#125;`</code>{" "}
              tries to access the property NOW
            </li>
            <li>
              But <code>article</code>{" "}
              is an OpaqueRef requiring reactive tracking
            </li>
            <li>
              <code>derive()</code>{" "}
              defers evaluation until reactive context exists
            </li>
          </ul>
        </div>
      </div>
    ),
    articles,
    summaries,
  };
});
