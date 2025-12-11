/// <cts-enable />
/**
 * TEST PATTERN: Template Strings Require derive()
 *
 * CLAIM: Template strings with multiple properties need derive() wrapper
 * SOURCE: folk_wisdom/llm.md - "When to Use derive() for generateObject Prompts"
 *
 * WHAT THIS TESTS:
 * - That template strings accessing multiple properties directly cause "opaque value" errors
 * - That wrapping in derive() fixes the issue
 * - This is JavaScript evaluation timing, not framework magic
 *
 * FRAMEWORK EVIDENCE:
 * - This is NOT about framework caching - it's about JavaScript template evaluation
 * - Template strings evaluate IMMEDIATELY: `foo ${bar.baz}` tries to access bar.baz NOW
 * - But bar might be an OpaqueRef, which requires reactive access tracking
 * - derive() defers evaluation until inside reactive context
 *
 * EXPECTED BEHAVIOR:
 * - BROKEN version: Console error "Tried to directly access an opaque value"
 * - WORKING version: No errors, generates successfully
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Deploy the pattern
 * 2. Add an article with title + content (format: "Title | Content")
 * 3. Check console for errors
 * 4. Observe which version (broken/working) shows results
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
  wordCount: number;
}

interface Input {
  articles: Default<Article[], []>;
}

const addArticle = handler<{ detail: { message: string } }, { articles: Cell<Article[]> }>(
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

export default pattern<Input>(({ articles }) => {
  // BROKEN: Direct template string tries to access OpaqueRef immediately
  // This causes "Tried to directly access an opaque value" error
  // because JavaScript evaluates `${article.title}` BEFORE the function runs
  const brokenSummaries = articles.map((article) => ({
    article,
    summary: generateObject<Summary>({
      system: "Summarize the article into main points.",
      // BROKEN: Direct template evaluation - article is OpaqueRef, not unwrapped
      prompt: `Title: ${article.title}\n\nContent: ${article.content}`,
      model: "anthropic:claude-sonnet-4-5",
    }),
  }));

  // WORKING: derive() wrapper defers evaluation
  // Framework tracks dependencies, evaluates inside reactive context
  const workingSummaries = articles.map((article) => ({
    article,
    summary: generateObject<Summary>({
      system: "Summarize the article into main points.",
      // WORKING: derive() defers template evaluation until reactive context
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
      <div style={{ padding: "20px", maxWidth: "800px", fontFamily: "system-ui" }}>
        <h2>Template Strings Require derive()</h2>

        <p style={{ color: "#666" }}>
          This pattern tests that template strings with multiple properties need derive() wrapper.
          The working version uses derive() to defer template evaluation.
        </p>

        <div style={{ margin: "20px 0" }}>
          <ct-message-input
            placeholder="Enter: Title | Content (e.g., 'React Tips | Use hooks for state')"
            appearance="rounded"
            onct-send={addArticle({ articles })}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginTop: "20px" }}>
          {/* BROKEN VERSION */}
          <div style={{ border: "2px solid #f44336", borderRadius: "6px", padding: "15px" }}>
            <h3 style={{ color: "#f44336", marginTop: 0 }}>BROKEN: Direct Template</h3>
            <p style={{ fontSize: "13px", color: "#666" }}>
              Using <code>`Title: $&#123;article.title&#125;...`</code> directly
            </p>
            <p style={{ fontSize: "12px", color: "#d32f2f", background: "#ffebee", padding: "8px", borderRadius: "4px" }}>
              Expected: "Tried to directly access an opaque value" error in console
            </p>

            {brokenSummaries.map((item, idx) => (
              <div
                key={idx}
                style={{ margin: "10px 0", padding: "10px", background: "#ffebee", borderRadius: "4px" }}
              >
                <div style={{ fontSize: "12px", marginBottom: "8px" }}>
                  <strong>{item.article.title}</strong>
                </div>
                {derive(
                  [item.summary.pending, item.summary.result, item.summary.error],
                  ([pending, result, error]) => {
                    if (pending) {
                      return (
                        <div style={{ color: "#666" }}>
                          <ct-loader show-elapsed /> Generating...
                        </div>
                      );
                    }
                    if (error) {
                      return (
                        <div style={{ color: "#d32f2f", fontSize: "12px" }}>
                          <strong>Error (expected):</strong> {String(error)}
                        </div>
                      );
                    }
                    const summaryResult = result as Summary | undefined;
                    if (summaryResult) {
                      return (
                        <div style={{ fontSize: "12px" }}>
                          <strong>Unexpected success!</strong> (This shouldn't happen)
                        </div>
                      );
                    }
                    return null;
                  },
                )}
              </div>
            ))}
          </div>

          {/* WORKING VERSION */}
          <div style={{ border: "2px solid #4CAF50", borderRadius: "6px", padding: "15px" }}>
            <h3 style={{ color: "#4CAF50", marginTop: 0 }}>WORKING: derive() Wrapper</h3>
            <p style={{ fontSize: "13px", color: "#666" }}>
              Using <code>derive(article, a =&gt; `Title: $&#123;a.title&#125;...`)</code>
            </p>
            <p style={{ fontSize: "12px", color: "#4CAF50", background: "#e8f5e9", padding: "8px", borderRadius: "4px" }}>
              Expected: Successful generation, no errors
            </p>

            {workingSummaries.map((item, idx) => (
            <div
              key={idx}
              style={{ margin: "10px 0", padding: "10px", background: "#e8f5e9", borderRadius: "4px" }}
            >
              <div style={{ fontSize: "12px", marginBottom: "8px" }}>
                <strong>{item.article.title}</strong>
              </div>
              {derive(
                [item.summary.pending, item.summary.result, item.summary.error],
                ([pending, result, error]) => {
                  if (pending) {
                    return (
                      <div style={{ color: "#666" }}>
                        <ct-loader show-elapsed /> Generating...
                      </div>
                    );
                  }
                  if (error) {
                    return (
                      <div style={{ color: "#d32f2f", fontSize: "12px" }}>
                        <strong>Error:</strong> {String(error)}
                      </div>
                    );
                  }
                  const summaryResult = result as Summary | undefined;
                  if (summaryResult) {
                    return (
                      <div style={{ fontSize: "12px" }}>
                        <strong>Summary:</strong>
                        <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
                          {summaryResult.mainPoints.map((point: string, i: number) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                        <div>Words: {summaryResult.wordCount}</div>
                      </div>
                    );
                  }
                  return null;
                },
              )}
            </div>
          ))}
          </div>
        </div>

        <div
          style={{
            marginTop: "30px",
            padding: "20px",
            background: "#e3f2fd",
            borderRadius: "6px",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Manual Testing Instructions:</h3>
          <ol style={{ lineHeight: 1.8 }}>
            <li>Add an article: "React Hooks | React Hooks let you use state"</li>
            <li>Open DevTools Console - look for errors</li>
            <li>Working version should show successful summary</li>
          </ol>

          <div
            style={{
              marginTop: "15px",
              padding: "10px",
              background: "white",
              borderRadius: "4px",
              fontSize: "13px",
            }}
          >
            <strong>Why derive() Is Needed:</strong>
            <ul style={{ margin: "10px 0", paddingLeft: "20px" }}>
              <li>JavaScript evaluates template strings IMMEDIATELY</li>
              <li>`foo $&#123;bar.baz&#125;` tries to access bar.baz before calling the function</li>
              <li>But article is an OpaqueRef requiring reactive tracking</li>
              <li>derive() defers evaluation until reactive context is established</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    articles,
    brokenSummaries,
    workingSummaries,
  };
});
