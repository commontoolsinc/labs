import { html } from "@commontools/common-html";
import {
  recipe,
  apply,
  handler,
  cell,
  generateData,
  UI,
  NAME,
} from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";

interface Playlist {
  title: string;
  songs: string[];
}

export const playlistForTrip = recipe<{
  ticket: { show: string };
  booking: any;
}>("playlist for trip", ({ ticket, booking }) => {
  const query = cell({
    prompt: "",
  });

  const generatePlaylist = handler<
    {},
    { ticket: { show: string }; booking: any; query: { prompt: string } }
  >({ ticket, booking, query }, (_, { ticket, query }) => {
    query.prompt = `Create a playlist in anticipation of a trip to see ${ticket.show}`;
  });

  const { result: playlist } = generateData<Playlist>({
    prompt: query.prompt,
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
            type: "string",
          },
          description: "10 songs to listen to on the way to the show",
        },
      },
    },
  });

  return {
    [UI]: html`
      <vstack gap="sm">
        <div>${playlist.title}</div>
        <vstack gap="xs">
          ${playlist.songs.map((song) => html` <div>${song}</div> `)}
        </vstack>
        <button @click=${generatePlaylist}>Generate Playlist</button>
      </vstack>
    `,
    query,
    playlist,
    [NAME]: apply({ playlist, ticket }, (playlist, ticket) =>
      playlist.title ? playlist.title : `Creating playlist for ${ticket.show}`
    ),
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
