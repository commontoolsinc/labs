import {
  Cell,
  computed,
  Default,
  generateText,
  handler,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
  wish,
  Writable,
} from "commonfabric";

type Input = {
  title?: string | Default<"Profile-Aware Writer">;
};

const handleSend = handler<
  { detail: { message: string } },
  { topic: Writable<string> }
>((event, { topic }) => {
  const userTopic = event.detail?.message?.trim();
  if (userTopic) {
    topic.set(userTopic);
  }
});

export default pattern<Input>(({ title }) => {
  const topic = new Writable("");

  const profile = wish<Cell<string>>({ query: "#learnedSummary" });
  const profileCell = resultOf(profile.result);

  const systemPrompt = computed(() => {
    const profileText = profileCell.get();
    const profileSection = profileText
      ? `\n\n--- About the User ---\n${profileText}\n---\n`
      : "";
    return `You are a helpful writing assistant.${profileSection}
Write content personalized to the user when appropriate.`;
  });

  const resultRequest = generateText({
    system: systemPrompt,
    prompt: topic,
  });
  const result = resultOf(resultRequest);

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <cf-card>
          <h4 style="margin-top: 0;">Profile Context:</h4>
          <cf-code-editor
            $value={profileCell}
            style={{ maxHeight: "256px" }}
          />
        </cf-card>

        <div>
          <cf-message-input
            name="Write"
            placeholder="Enter a topic to write about..."
            appearance="rounded"
            oncf-send={handleSend({ topic })}
          />
        </div>

        <cf-cell-context $cell={topic}>
          {topic.get()
            ? (
              <div style="margin-top: 16px;">
                <h3>Topic:</h3>
                <blockquote>
                  {topic.get()}
                </blockquote>
              </div>
            )
            : null}
        </cf-cell-context>

        <cf-cell-context $cell={resultRequest}>
          {isPending(resultRequest)
            ? (
              <div style="margin-top: 16px;">
                <cf-loader show-elapsed /> Generating personalized content...
              </div>
            )
            : result
            ? (
              <div style="margin-top: 16px;">
                <h3>Generated Text:</h3>
                <div style="white-space: pre-wrap; padding: 12px; background: #f9f9f9; border-radius: 4px; line-height: 1.6;">
                  {result}
                </div>
              </div>
            )
            : null}
        </cf-cell-context>
      </div>
    ),
    topic,
    response: result,
  };
});
