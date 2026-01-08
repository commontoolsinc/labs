/// <cts-enable />
/**
 * Test Pattern: generateObject schema `required` field validation
 *
 * Tests superstition: generateObject-schema-requires-required-fields
 * Claim: Missing `required` at nested object levels causes HTTP 400
 *
 * NOTE: Both tests run on page load. CTS generates schemas from TypeScript
 * interfaces - if both succeed, CTS handles `required` automatically.
 *
 * Deploy: deno task ct charm new packages/patterns/gideon-tests/test-llm-required-fields.tsx -i claude.key -a http://localhost:8000 -s gideon-test
 */

import { Default, NAME, pattern, UI, ifElse } from "commontools";
import { generateObject } from "commontools";

interface ClassInfo {
  name: string;
  dayOfWeek: string;
  startTime: string;
}

// Schema WITH explicit nested interface (allegedly works)
interface WithRequired {
  classes: ClassInfo[];
}

// Schema WITH inline nested object - tests if CTS handles this too
interface WithInlineNested {
  items: {
    title: string;
    category: string;
  }[];
}

interface Input {
  testPrompt: Default<string, "List 2 yoga classes: Monday morning yoga at 9am, Wednesday evening yoga at 6pm">;
}

export default pattern<Input, Input>(({ testPrompt }) => {
  // Test 1: Named interface for nested object
  const resultWithRequired = generateObject<WithRequired>({
    prompt: testPrompt,
    system: "Extract class information from the text. Return a list of classes with name, dayOfWeek, and startTime.",
    model: "anthropic:claude-haiku-4-5",
  });

  // Test 2: Inline nested object definition
  const resultWithInlineNested = generateObject<WithInlineNested>({
    prompt: testPrompt,
    system: "Extract items from the text. Return a list of items with title and category.",
    model: "anthropic:claude-haiku-4-5",
  });

  return {
    [NAME]: "LLM Required Fields Test",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "sans-serif", display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2>generateObject `required` Field Test</h2>

        <div style={{ padding: "12px", backgroundColor: "#f0f0f0", borderRadius: "8px" }}>
          <strong>Test Prompt:</strong> {testPrompt}
        </div>

        <div style={{ border: "2px solid #28a745", padding: "16px", borderRadius: "8px" }}>
          <h3 style={{ color: "#28a745" }}>Test 1: Named Interface (ClassInfo[])</h3>
          <p>Uses a separate interface for the nested object.</p>

          <div style={{ marginTop: "8px", padding: "8px", backgroundColor: "#f8f9fa", borderRadius: "4px" }}>
            <strong>Status:</strong>{" "}
            {ifElse(
              resultWithRequired.pending,
              "⏳ Pending...",
              ifElse(
                resultWithRequired.error,
                <span style={{ color: "red" }}>❌ Error: {resultWithRequired.error}</span>,
                <span style={{ color: "green" }}>✅ Success</span>
              )
            )}
            <br />
            <strong>Result:</strong> {JSON.stringify(resultWithRequired.result)}
          </div>
        </div>

        <div style={{ border: "2px solid #007bff", padding: "16px", borderRadius: "8px" }}>
          <h3 style={{ color: "#007bff" }}>Test 2: Inline Nested Object</h3>
          <p>Uses inline object definition in array type. If superstition applies, this might fail.</p>

          <div style={{ marginTop: "8px", padding: "8px", backgroundColor: "#f8f9fa", borderRadius: "4px" }}>
            <strong>Status:</strong>{" "}
            {ifElse(
              resultWithInlineNested.pending,
              "⏳ Pending...",
              ifElse(
                resultWithInlineNested.error,
                <span style={{ color: "red" }}>❌ Error: {resultWithInlineNested.error}</span>,
                <span style={{ color: "green" }}>✅ Success</span>
              )
            )}
            <br />
            <strong>Result:</strong> {JSON.stringify(resultWithInlineNested.result)}
          </div>
        </div>

        <div style={{ border: "2px solid #333", padding: "16px", borderRadius: "8px", backgroundColor: "#f8f9fa" }}>
          <h3>Expected Results</h3>
          <ul style={{ margin: "8px 0", paddingLeft: "20px" }}>
            <li><strong>If superstition CONFIRMED:</strong> Test 2 fails with HTTP 400 (missing required on nested)</li>
            <li><strong>If superstition DISPROVED:</strong> Both tests succeed (CTS handles required automatically)</li>
          </ul>
          <p><em>Note: The superstition was about manually-written JSON schemas. CTS may handle this automatically.</em></p>
        </div>
      </div>
    ),
    testPrompt,
  };
});
