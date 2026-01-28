/// <cts-enable />
import {
  computed,
  Default,
  derive,
  generateText,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

type Input = {
  title?: Default<string, "Profile-Aware Writer">;
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
  const topic = Writable.of("");

  const profile = wish<string>({ query: "#profile" });

  const systemPrompt = computed(() => {
    const profileText = profile.result;
    const profileSection = profileText
      ? `\n\n--- About the User ---\n${profileText}\n---\n`
      : "";
    return `You are a helpful writing assistant.${profileSection}
Write content personalized to the user when appropriate.`;
  });

  const result = generateText({
    system: systemPrompt,
    prompt: topic,
  });

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <ct-cell-context $cell={profile.result}>
          {derive(profile.result, (p) =>
            p
              ? (
                <div style="margin-bottom: 16px; padding: 12px; background: #f5f5f5; border-radius: 4px;">
                  <h4 style="margin-top: 0;">Profile Context:</h4>
                  <blockquote style="margin: 0; font-size: 0.9em; color: #666;">
                    {p}
                  </blockquote>
                </div>
              )
              : (
                <div style="margin-bottom: 16px; padding: 12px; background: #fff3cd; border-radius: 4px; color: #856404;">
                  No profile found. Content will be generic.
                </div>
              ))}
        </ct-cell-context>

        <div>
          <ct-message-input
            name="Write"
            placeholder="Enter a topic to write about..."
            appearance="rounded"
            onct-send={handleSend({ topic })}
          />
        </div>

        <ct-cell-context $cell={topic}>
          {derive(topic, (t) =>
            t
              ? (
                <div style="margin-top: 16px;">
                  <h3>Topic:</h3>
                  <blockquote>
                    {t}
                  </blockquote>
                </div>
              )
              : null)}
        </ct-cell-context>

        <ct-cell-context $cell={result}>
          {derive(
            [result.pending, result.result],
            ([pending, r]) =>
              pending
                ? (
                  <div style="margin-top: 16px;">
                    <ct-loader show-elapsed />{" "}
                    Generating personalized content...
                  </div>
                )
                : r
                ? (
                  <div style="margin-top: 16px;">
                    <h3>Generated Text:</h3>
                    <div style="white-space: pre-wrap; padding: 12px; background: #f9f9f9; border-radius: 4px; line-height: 1.6;">
                      {r}
                    </div>
                  </div>
                )
                : null,
          )}
        </ct-cell-context>
      </div>
    ),
    topic,
    response: result.result,
  };
});
