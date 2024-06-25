import { view, tags } from "@commontools/common-ui";
import { state, computed, effect } from "@commontools/common-frp/signal";
import { generateData } from "@commontools/llm-client";
import { mockResultClient } from "../llm-client.js";
import { recipe, Gem, NAME, addSuggestion, description } from "../recipe.js";
const { repeat } = view;
const { vstack, hstack, div, commonInput, button, input, include } = tags;

interface Playlist {
  title: string;
  songs: string[];
}

export const playlistForTrip = recipe(
  "playlist for trip",
  ({ ticket, booking }) => {
    const playlist = state<Playlist>({ title: "", songs: [] });
    const name = computed([playlist, ticket], (playlist, ticket: Gem) =>
      playlist.title
        ? playlist.title
        : `Creating playlist for ${ticket.show.get()}`
    );

    effect([ticket, booking], (ticket: Gem, booking: Gem) => {
      if (!ticket || !booking) return;
      const result = generateData(
        mockResultClient,
        `Create a playlist in anticipation of a trip to see ${ticket.show.get()}`,
        {},
        {
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
        }
      );

      result.then((data) => playlist.send(data as Playlist));
    });
    return {
      UI: computed([playlist], (playlist: Playlist) =>
        vstack({}, [
          playlist.title,
          vstack(
            {},
            repeat(state(playlist.songs), (song: string) => div({}, [song]))
          ),
        ])
      ),
      [NAME]: name,
      playlist,
    };
  }
);

addSuggestion({
  description: description`Make a playlist for ${"ticket"}`,
  recipe: playlistForTrip,
  bindings: { sagas: "sagas" },
  dataGems: {
    ticket: "ticket",
    booking: "booking",
  },
});
