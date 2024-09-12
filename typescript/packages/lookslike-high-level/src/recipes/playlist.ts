import { html } from "@commontools/common-html";
import {
  recipe,
  str,
  lift,
  generateData,
  ifElse,
  UI,
  NAME,
} from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";

interface Playlist {
  title: string;
  songs: { name: string; artist: string }[];
}

export const playlistForTrip = recipe<{
  ticket: { show: string };
  booking: any;
}>("playlist for trip", ({ ticket }) => {
  const { result: playlist } = generateData<Playlist>({
    prompt: str`Create a fun playlist in anticipation of a trip to see ${ticket.show}`,
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          title: "Title of the playlist",
        },
        songs: {
          type: "array",
          title: "Songs",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                title: "Song name",
              },
              artist: {
                type: "string",
                title: "Artist",
              },
            },
          },
          description: "10 songs to listen to on the way to the show",
        },
      },
    },
  });

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
  bindings: { sagas: "sagas" },
  dataGems: {
    ticket: "ticket",
    booking: "booking",
  },
});
