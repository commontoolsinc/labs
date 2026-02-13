/// <cts-enable />
import {
  computed,
  generateObject,
  NAME,
  pattern,
  patternTool,
  str,
  toSchema,
  UI,
  Writable,
} from "commontools";
import { readWebpage, searchWeb } from "./system/common-tools.tsx";

type ResearchResult = {
  /** Concise answer to the research question */
  summary: string;
  /** Key findings from the research */
  findings: {
    title: string;
    source: string;
    content: string;
  }[];
  /** List of URLs consulted */
  sources: string[];
  /** Confidence level in the answer */
  confidence: "high" | "medium" | "low";
};

export default pattern<
  { question: string; context?: { [id: string]: any } },
  {
    question: string;
    result: Writable<ResearchResult | undefined>;
    pending: boolean;
    error?: unknown;
  }
>(({ question, context }) => {
  const research = generateObject({
    system:
      `You are a deep research agent. Given a question, use the available tools to:
1. Search the web for relevant information
2. Read promising web pages to gather detailed content
3. Synthesize your findings into a comprehensive answer

Be thorough - search for multiple aspects of the question and read several sources before forming your answer.`,
    prompt: question,
    context,
    tools: {
      searchWeb: patternTool(searchWeb),
      readWebpage: patternTool(readWebpage),
    },
    schema: toSchema<ResearchResult>(),
    model: "anthropic:claude-sonnet-4-5",
  });

  return {
    [NAME]: str`Research: ${question}`,
    result: research.result,
    pending: research.pending,
    error: research.error,
    question,
    [UI]: (
      <div>
        <ct-textarea
          $value={question}
          placeholder="Enter your research question..."
        />
        {computed(() => {
          if (research.pending) return <div>Researching...</div>;
          if (research.error) return <div>Error: {String(research.error)}</div>;
          if (!research.result) return <div>No results</div>;
          return (
            <div>
              <h3>Summary</h3>
              <p>{research.result.summary}</p>
              <p>
                <em>Confidence: {research.result.confidence}</em>
              </p>
              <h3>Sources</h3>
              <ul>
                {research.result.sources.map((url: string) => (
                  <li>
                    <a href={url} target="_blank">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    ),
  };
});
