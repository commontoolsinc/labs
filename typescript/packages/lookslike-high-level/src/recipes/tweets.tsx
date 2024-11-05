import { h } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  ifElse,
  str,
} from "@commontools/common-builder";
import { z } from "zod";
import { zodSchemaQuery } from "../query.js";

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

const Tweets = z
  .object({
    username: z.string().default(""),
  })
  .describe("Tweets");

const dateStringToNiceDateString = lift((dateString: string) => {
  const date = new Date(dateString);
  return date.toDateString();
});

const tap = lift((x) => {
  console.log("tap!", JSON.stringify(x));
  return x;
});

export const tweets = recipe(Tweets, ({ username }) => {
  const { result: items } = zodSchemaQuery(Tweet);

  return {
    [NAME]: str`Tweets: ${username}`,
    [UI]: (
      <os-container>
        <common-vstack gap="md">
          {items.map((item) => (
            <sl-card class="tweet">
              <common-hstack slot="header" gap="md">
                <sl-avatar></sl-avatar>
                <div>{username}</div>
              </common-hstack>
              <div class="tweet-content">{item.full_text}</div>
              <common-hstack slot="footer" gap="md">
                <common-hstack>
                  {ifElse(
                    item.favorited,
                    <sl-icon-button
                      library="material"
                      name="favorite"
                      label="Favorite"
                      fill
                    ></sl-icon-button>,
                    <sl-icon-button
                      library="material"
                      name="favorite"
                      label="Favorite"
                    ></sl-icon-button>,
                  )}
                  <div>{item.favorite_count}</div>
                </common-hstack>
                <div>{dateStringToNiceDateString(item.created_at)}</div>
              </common-hstack>
            </sl-card>
          ))}
        </common-vstack>
      </os-container>
    ),
    username,
    items,
  };
});
