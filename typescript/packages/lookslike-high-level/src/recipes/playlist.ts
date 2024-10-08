import { html } from "@commontools/common-html";
import {
  recipe,
  str,
  lift,
  llm,
  ifElse,
  UI,
  NAME,
} from "@commontools/common-builder";
import { addSuggestion, description } from "../suggestions.js";
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

const Playlist = z.object({
  title: z.string().describe('Title of the playlist'),
  songs: z.array(
    z.object({
      name: z.string().describe('Song name'),
      artist: z.string().describe('Artist name'),
    })
  ).describe('List of songs in the playlist'),
});
type Playlist = z.infer<typeof Playlist>;
const jsonSchema = JSON.stringify(zodToJsonSchema(Playlist), null, 2);


const grabJson = lift<{ result: string }, Playlist | undefined>(({ result }) => {
  if (!result) {
      return {};
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
      console.error("No JSON found in text:", result);
      return {};
  }
  let rawData = JSON.parse(jsonMatch[1]);
  let parsedData = Playlist.safeParse(rawData);
  if (!parsedData.success) {
      console.error("Invalid JSON:", parsedData.error);
      return;
  }
  return parsedData.data;
})


export const playlistForTrip = recipe<{
  ticket: { show: string };
  booking: any;
}>("playlist for trip", ({ ticket }) => {

  const playlist = grabJson(llm({
    messages: [str`Create a fun playlist in anticipation of a trip to see ${ticket.show}`,
      '```json\n{'],
    system: `Generate playlist data inspired by the user description using JSON:\n\n<schema>${jsonSchema}</schema>`,
    stop: '```'
  }));

  return {
    [UI]: html`
      <common-vstack gap="sm"
        >${ifElse(
          playlist,
          html`<div>
            <div>${playlist.title}</div>
            <common-vstack gap="xs">
              ${playlist.songs.map(
                (song) => html` <div>${song.name} by ${song.artist}</div> `
              )}
            </common-vstack>
          </div>`,
          "Creating playlist..."
        )}
      </common-vstack>
    `,
    playlist,
    [NAME]: lift(({ playlist, ticket }) =>
      playlist?.title ? playlist.title : `Creating playlist for ${ticket.show}`
    )({ playlist, ticket }),
  };
});

addSuggestion({
  description: description`Make a playlist for ${"ticket"}`,
  recipe: playlistForTrip,
  bindings: { charms: "charms" },
  charms: {
    ticket: "ticket",
    booking: "booking",
  },
});
