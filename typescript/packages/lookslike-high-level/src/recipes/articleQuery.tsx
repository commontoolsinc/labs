import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
} from "@commontools/common-builder";
import * as z from "zod";
import { buildTransactionRequest, zodSchemaQuery } from "../query.js";
import { h } from "@commontools/common-html";

export const schema = z.object({
  title: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
});

const onAddItem = handler<{}, { titleInput: string; authorInput: string }>(
  (_e, state) => {
    const titleInput = state.titleInput;
    const authorInput = state.authorInput;
    state.titleInput = "";
    state.authorInput = "";
    return fetchData(
      buildTransactionRequest(prepChanges({ titleInput, authorInput })),
    );
  },
);

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const prepChanges = lift(({ titleInput, authorInput }) => {
  return {
    changes: [
      {
        Import: {
          title: titleInput,
          author: authorInput,
          tags: ["tag1"],
        },
      },
    ],
  };
});

export const articleQuery = recipe(
  z
    .object({ titleInput: z.string(), authorInput: z.string() })
    .describe("Articles query"),
  ({ titleInput, authorInput }) => {
    const { result: items, query } = zodSchemaQuery(schema);
    tap({ obj: items });

    const onChange = handler<InputEvent, { titleInput: string }>((e, state) => {
      state.titleInput = (e.target as HTMLInputElement).value;
    });

    const onAuthorChange = handler<InputEvent, { authorInput: string }>(
      (e, state) => {
        state.authorInput = (e.target as HTMLInputElement).value;
      },
    );

    return {
      [NAME]: "Article query",
      [UI]: (
        <div>
          <div>
            <input
              value={titleInput}
              placeholder="Article title"
              oninput={onChange({ titleInput })}
            ></input>
            <input
              value={authorInput}
              placeholder="Article author"
              oninput={onAuthorChange({ authorInput })}
            ></input>
            <button onclick={onAddItem({ titleInput, authorInput })}>
              Add
            </button>
          </div>
          <ul>
            {items.map(({ title, author, tags }) => (
              <li>
                {title} - {author}
                <ul>
                  {tags.map((tag) => (
                    <li>{tag}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ),
      data: items,
      query,
    };
  },
);
