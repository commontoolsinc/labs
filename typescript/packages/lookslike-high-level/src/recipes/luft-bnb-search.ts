import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { generateData } from "@commontools/llm-client";
import { Gem, recipe, NAME, addSuggestion, description } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
import { mockResultClient } from "../llm-client.js";
const { binding, repeat } = view;
const { vstack, hstack, div, commonInput, button, input, include } = tags;
const { state, computed } = signal;
const { subject } = stream;

export interface LuftBnBPlace {
  // Schema for a place
  id: string;
  title: string;
  host: string;
  location: string;
  propertyType: "Apartment" | "House" | "Room";
  pricePerNight: number;
  numberOfGuests: number;
  latitude: number;
  longitude: number;
  rating: number;
}

export const luftBnBSearch = recipe(
  "local search",
  ({ startDate, endDate, location }) => {
    // Initial search
    const places = state<LuftBnBPlace[]>([]);
    performLuftBnBSearch(location.get()).then((results) =>
      places.send(results)
    );

    const search = subject<any>();
    search.sink({
      send: () =>
        performLuftBnBSearch(location.get()).then((results) =>
          places.send(results)
        ),
    });

    const summaries = computed([places], (places: LuftBnBPlace[]) =>
      places.map((place) => ({
        id: place.id,
        name: place.title,
        description:
          place.propertyType + `, ${place.numberOfGuests} max guests`,
        location: place.location,
        rating: `${"⭐⭐⭐⭐⭐".slice(0, place.rating)} (${place.rating})`,
        bookFor: `Book for $${place.pricePerNight} per night`,
      }))
    );

    const book = subject<{ id: string }>();
    book.sink({
      send: ({ id }) =>
        console.log(
          "Booked",
          places.get().find((place) => place.id === id)
        ),
    });

    const summaryUI = computed(
      [places, startDate, endDate],
      (places: LuftBnBPlace[], startDate, endDate) => {
        if (!places.length) return div({}, ["Searching..."]);
        const place = places[0];
        return vstack({}, [
          `${place.propertyType}, ${startDate}-${endDate} in ${place.location}. ` +
            `${"⭐⭐⭐⭐⭐".slice(0, place.rating)} (${place.rating})`,
          button({ "@click": book, id: place.id }, [
            `Book for $${place.pricePerNight} per night`,
          ]),
        ]);
      }
    );

    return {
      UI: vstack({}, [
        hstack({}, [
          input({
            type: "date",
            value: startDate,
            placeholder: "Type of place",
            "@common-input#value": startDate,
          }),
          input({
            type: "date",
            value: endDate,
            placeholder: "Type of place",
            "@common-input#value": endDate,
          }),
        ]),
        commonInput({
          value: location,
          placeholder: "Location",
          "@common-input#value": location,
        }),
        button({ "@click": search }, ["Search"]),
        vstack(
          {},
          repeat(
            summaries,
            vstack({}, [
              div({}, binding("name")),
              div({}, binding("description")),
              div({}, binding("location")),
              div({}, binding("rating")),
              button({ "@click": book, id: binding("id") }, binding("bookFor")),
            ])
          )
        ),
      ]),
      summaryUI: summaryUI,
      startDate,
      endDate,
      location,
      luftbnbs: places,
      [NAME]: computed(
        [location, startDate, endDate],
        (location, startDate: string, endDate: string) =>
          `LuftBnB ${startDate.slice(5)} - ${endDate.slice(5)} in ${location || "anywhere"}`
      ),
    };
  }
);

async function performLuftBnBSearch(location: string): Promise<LuftBnBPlace[]> {
  if (!location) return [];
  const result = await generateData(
    mockResultClient,
    `generate 10 places for private home short-term rentals in ${location}`,
    [],
    {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique identifier for the listing",
          },
          title: {
            type: "string",
            description: "Title of the listing",
          },
          location: {
            type: "string",
            description: "Street corner, Neighborhood and city of the listing",
          },
          propertyType: {
            type: "string",
            enum: ["Apartment", "House", "Room"],
          },
          pricePerNight: {
            type: "number",
            minimum: 0,
          },
          numberOfGuests: {
            type: "integer",
            minimum: 1,
          },
          latitude: {
            type: "number",
          },
          longitude: {
            type: "number",
          },
          rating: {
            type: "number",
            minimum: 0,
            maximum: 5,
            description: "Average rating of the listing",
          },
        },
        required: [
          "id",
          "title",
          "host",
          "location",
          "propertyType",
          "pricePerNight",
          "numberOfGuests",
          "imageUrl",
        ],
      },
    }
  );
  return result as LuftBnBPlace[];
}

const makeLuftBnBSearch = recipe(
  "book luftBnB for reservation",
  ({ reservation }) => {
    const luftBnB: signal.Signal<Gem> = computed(
      [reservation],
      ({ date, location }) => {
        console.log("Making LuftBnB search for", date.get(), location.get());
        const startDate = computed(
          [date],
          (date: string) =>
            new Date(new Date(date).getTime() - 86400)
              .toISOString()
              .split("T")[0]
        );
        const endDate = computed(
          [date],
          (date: string) =>
            new Date(new Date(date).getTime() + 86400)
              .toISOString()
              .split("T")[0]
        );

        return luftBnBSearch({
          startDate,
          endDate,
          location,
        });
      }
    );

    return {
      UI: vstack({}, [
        sagaLink({ saga: luftBnB }),
        include({
          // TODO: This should be a computed, but we can't yet flatten computed values
          content: luftBnB.get().summaryUI,
        }),
      ]),
      reservation,
      luftBnBSearch: luftBnB,
    };
  }
);

addSuggestion({
  description: description`Book LuftBnB for ${"reservation"}`,
  recipe: makeLuftBnBSearch,
  bindings: {},
  dataGems: {
    reservation: "reservation",
  },
});
