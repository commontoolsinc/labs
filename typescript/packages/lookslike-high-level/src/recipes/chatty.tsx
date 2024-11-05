import { h } from "@commontools/common-html";
import {
  llm,
  recipe,
  NAME,
  UI,
  lift,
  ifElse,
} from "@commontools/common-builder";
import { z } from "zod";

const genImage = lift(
  ({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`,
);

const Chat = z
  .object({
    prompt: z.string(),
    question: z.string(),
  })
  .describe("Chat Box");

const prepText = lift(({ prompt, question }) => {
  if (prompt && question) {
    return {
      messages: [question],
      model: "groq:llama-3.1-8b-instant",
      system: `Respond to the user question in 1 sentence in a given character.

<character>${prompt}</character>`,
    };
  }
  return {};
});
const prepImage = lift(({ answer, prompt, question }) => {
  if (answer && prompt && question) {
    return {
      messages: [answer],
      model: "groq:llama-3.1-8b-instant",
      system: `Create a short prompt describing an image that matches the user who is asking: <question>${question}</question> and is a <character>${prompt}</character>`,
    };
  }
  return {};
});

export const chat = recipe(Chat, ({ prompt, question }) => {
  const { partial: answer, result: finalAnswer } = llm(
    prepText({ prompt, question }),
  );
  const { result: imgAnswer } = llm(
    prepImage({ answer: finalAnswer, prompt, question }),
  );

  return {
    [NAME]: "prompt",
    [UI]: (
      <span class="chatBox">
        <div class="imageWrapper">
          <img src={genImage({ prompt: prompt })} title={prompt} />
        </div>
        {ifElse(answer, <span>{answer}</span>, <span>{prompt}</span>)}
        {ifElse(
          imgAnswer,
          <img
            src={genImage({ prompt: imgAnswer })}
            width={128}
            height={128}
            title={imgAnswer}
          />,
          <span></span>,
        )}

        <style type="text/css">{`
                .chatBox {
                    display: flex;
                    flexDirection: column;
                    align-items: center;
                    width: 100%;
                }
                .imageWrapper {
                    min-width: 200px;
                    width: 200px;
                    height: 200px;
                    flex-shrink: 0;
                    border-radius: 50%;
                    overflow: hidden;
                    margin: 10px;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                }
                .imageWrapper img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
            `}</style>
      </span>
    ),
  };
});
