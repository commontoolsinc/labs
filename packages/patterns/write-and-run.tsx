/// <cts-enable />
import {
  Cell,
  compileAndRun,
  computed,
  Default,
  derive,
  generateText,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
} from "commontools";

// Template for the AI to reference
const TEMPLATE = `/// <cts-enable />
import { Cell, derive, handler, Default, NAME, pattern, UI } from "commontools";

interface Input {
  value: Default<number, 0>;
}

const increment = handler<unknown, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() + 1)
);

const decrement = handler<unknown, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() - 1)
);

export default pattern<Input>(({ value }) => {
  return {
    [NAME]: derive(value, (v) => \`Counter: \${v}\`),
    [UI]: (
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <ct-button onClick={decrement({ value })}>-</ct-button>
        <span>{value}</span>
        <ct-button onClick={increment({ value })}>+</ct-button>
      </div>
    ),
    value,
  };
});`;

const SYSTEM_PROMPT =
  `You are a CommonTools pattern generator. Given a user request, generate a complete TypeScript pattern file.

IMPORTANT RULES:
1. Start with: /// <cts-enable />
2. Import from "commontools": Cell, Default, derive, handler, NAME, pattern, UI, computed, ifElse
3. Use the pattern<Input>() or pattern<Input, Output>() API
4. For arrays that need mutation, use Cell<T[]> in the interface
5. Use $checked, $value for bidirectional binding on ct-checkbox, ct-input
6. Use inline handlers for simple operations, handler() for complex ones
7. Always return [NAME] and [UI] from the pattern

TEMPLATE FOR REFERENCE:
${TEMPLATE}

Generate ONLY the TypeScript code, no explanations or markdown.`;

interface Input {
  prompt: Default<string, "Create a simple counter">;
}

interface Output {
  prompt: Cell<string>;
}

const updatePrompt = handler<
  { detail: { message: string } },
  { prompt: Cell<string> }
>((event, { prompt }) => {
  const newPrompt = event.detail?.message?.trim();
  if (newPrompt) {
    prompt.set(newPrompt);
  }
});

const visit = handler<unknown, { result: Cell<any> }>((_, { result }) => {
  return navigateTo(result);
});

export default pattern<Input, Output>(({ prompt }) => {
  // Step 1: Generate pattern source code from prompt
  const generated = generateText({
    system: SYSTEM_PROMPT,
    prompt,
    model: "anthropic:claude-sonnet-4-5",
  });

  const processedResult = computed(() => {
    const result = generated?.result ?? "";
    // Remove wrapping ```typescript``` if it exists
    return result.replace(/^```typescript\n?/, "").replace(/\n?```$/, "");
  });

  // Step 2: Compile the generated code when ready
  const compileParams = derive(processedResult, (p) => ({
    files: p ? [{ name: "/main.tsx", contents: p }] : [],
    main: p ? "/main.tsx" : "",
  }));

  const compiled = compileAndRun(compileParams);

  // Compute states
  const isGenerating = generated.pending;
  const hasCode = computed(() => !!generated.result);
  const hasError = computed(() => !!compiled.error);
  const isReady = computed(() =>
    !compiled.pending && !!compiled.result && !compiled.error
  );

  return {
    [NAME]: "Write and Run",
    [UI]: (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "16px",
        }}
      >
        <h2>Write and Run</h2>
        <p style={{ color: "#666" }}>
          Describe a pattern and I'll generate, compile, and run it.
        </p>

        <ct-message-input
          placeholder="Describe the pattern you want..."
          onct-send={updatePrompt({ prompt })}
        />

        <div
          style={{
            padding: "12px",
            backgroundColor: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          {ifElse(
            isGenerating,
            <span>Generating code...</span>,
            ifElse(
              hasError,
              <div style={{ color: "red" }}>
                <b>Compile error:</b> {compiled.error}
              </div>,
              ifElse(
                isReady,
                <ct-button onClick={visit({ result: compiled.result })}>
                  Open Generated Pattern
                </ct-button>,
                <span style={{ opacity: 0.6 }}>
                  Enter a prompt to generate a pattern
                </span>,
              ),
            ),
          )}
        </div>

        {ifElse(
          isReady,
          <div>
            <h3>Generated Pattern</h3>
            <div
              style={{
                border: "1px solid #ccc",
                borderRadius: "8px",
                padding: "16px",
                backgroundColor: "#fff",
              }}
            >
              {compiled.result}
            </div>
          </div>,
          <span />,
        )}

        {ifElse(
          hasCode,
          <div>
            <h3>Generated Code</h3>
            <ct-code-editor
              value={generated.result}
              language="text/x.typescript"
              readonly
            />
          </div>,
          <span />,
        )}
      </div>
    ),
    prompt,
    generatedCode: generated.result,
    compiledCharm: compiled.result,
    error: compiled.error,
  };
});
