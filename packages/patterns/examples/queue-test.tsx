/// <cts-enable />
import {
  computed,
  Default,
  generateText,
  NAME,
  pattern,
  UI,
} from "commontools";

type QueueTestInput = {
  title: Default<string, "Queue Test">;
};

/**
 * Test pattern for the queue feature.
 *
 * Fires 5 generateText calls, all routed through the same "test-queue"
 * with maxConcurrency=2 (the default). Open the browser network tab
 * to observe that only 2 LLM requests are in-flight at once.
 */
export default pattern<QueueTestInput>(({ title }) => {
  const prompts = [
    "What is 1+1? Reply in one word.",
    "What is 2+2? Reply in one word.",
    "What is 3+3? Reply in one word.",
    "What is 4+4? Reply in one word.",
    "What is 5+5? Reply in one word.",
  ];

  const responses = prompts.map((prompt) =>
    generateText({
      prompt,
      model: "anthropic:claude-haiku-4-5",
      queue: "test-queue",
    })
  );

  const completedCount = computed(() =>
    responses.filter((r) => !r.pending && r.result).length
  );

  return {
    [NAME]: title,
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={3}>{title}</ct-heading>
          <p>
            Fires 5 LLM calls through queue "test-queue" (maxConcurrency=2).
            Check the network tab to verify only 2 are in-flight at once.
          </p>
          <p>
            <strong>Completed: {completedCount} / {prompts.length}</strong>
          </p>
        </ct-vstack>

        <ct-vstack gap="2" style="padding: 1rem;">
          {responses.map((r, i) => (
            <ct-card>
              <ct-hstack gap="2" align="center">
                <strong>{prompts[i]}</strong>
                {computed(() =>
                  r.pending
                    ? <ct-loader show-elapsed />
                    : r.result
                    ? <span style="color: green">{r.result}</span>
                    : <span style="color: gray">waiting...</span>
                )}
              </ct-hstack>
            </ct-card>
          ))}
        </ct-vstack>
      </ct-screen>
    ),
    responses: responses.map((r) => ({
      pending: r.pending,
      result: r.result,
    })),
  };
});
