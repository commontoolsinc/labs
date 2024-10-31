import { h } from "@commontools/common-html";
import { recipe, UI, NAME, lift, ifElse } from "@commontools/common-builder";
import { z } from "zod";
import { buildTransactionRequest, queryRecipe, schemaQuery } from "../query.js";

const Tweet = z
  .object({
    id: z.string(),
    full_text: z.string(),
    favorited: z.boolean(),
    favorite_count: z.string(),
    in_reply_to_status_id_str: z.string(),
    created_at: z.string(),
  })
  .describe("Tweet");

const TweetItem = z.object({
  tweet: z.array(Tweet),
});

const Tweets = z
  .object({
    title: z.string(),
    items: z.array(TweetItem),
  })
  .describe("Tweets");

const dateStringToNiceDateString = lift((dateString: string) => {
  const date = new Date(dateString);
  return date.toDateString();
});

export const tweets = recipe(Tweets, ({ title }) => {
  const { result: items } = schemaQuery(Tweet);
  return {
    [NAME]: "Tweets",
    [UI]: (
      <os-container>
        <common-vstack gap="md">
          {items.map((item) => {
            return (
              <sl-card class="tweet">
                <common-hstack slot="header">
                  <sl-avatar></sl-avatar>
                </common-hstack>
                <div class="tweet-content">{item.full_text}</div>
                <common-hstack slot="footer" gap="md">
                  {ifElse(
                    item.favorited,
                    <sl-button>Favorite</sl-button>,
                    <sl-button>Not favorite</sl-button>,
                  )}
                  <sl-button>{item.favorite_count}</sl-button>
                  <div>{dateStringToNiceDateString(item.created_at)}</div>
                </common-hstack>
              </sl-card>
            );
          })}
        </common-vstack>
      </os-container>
    ),
    title,
    items,
  };
});
