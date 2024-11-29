
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
  ifElse,
} from "@commontools/common-builder";
import { z } from "zod";

// Define a Kitty counter type
const KittyCounter = z.object({ 
  name: z.string(), 
  pats: z.number() 
});
type KittyCounter = z.infer<typeof KittyCounter>;

const Schema = z
  .object({
    kitties: z.array(KittyCounter).default([]),
    title: z.string().default("Kitty Pat Counter"),
  })
  .describe("Kitty Pat Counter");
type Schema = z.infer<typeof Schema>;

// Handler to update the title
const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    detail?.value && (state.title = detail.value);
  },
);

// Handler to pat a specific kitty
const patKitty = handler<{}, { kitty: KittyCounter }>(({}, { kitty }) => {
  kitty.pats += 1;
});

// Handler to pat a random kitty
const patRandomKitty = handler<{}, { kitties: KittyCounter[] }>(({}, state) => {
  if (state.kitties.length > 0) {
    state.kitties[Math.floor(Math.random() * state.kitties.length)].pats += 1;
  }
});

// Handler to adopt (add) a new kitty
const adoptKitty = handler<{}, { kitties: KittyCounter[] }>(({}, state) => {
  state.kitties.push({ 
    name: `Kitty ${state.kitties.length + 1}`, 
    pats: 0 
  });
});

// Handler to say goodbye (remove) a kitty
const goodbyeKitty = handler<{}, { kitties: KittyCounter[]; kitty: KittyCounter }>(
  ({}, state) => {
    const index = state.kitties.findIndex((k) => k.name === state.kitty.name);
    state.kitties.splice(index, 1);
  },
);

// Lift to calculate total pats
const calculateTotalPats = lift(({ kitties }: { kitties: KittyCounter[] }) =>
  kitties.reduce((total: number, kitty: KittyCounter) => total + kitty.pats, 0),
);

export default recipe(Schema, ({ kitties, title }) => {
  const totalPats = calculateTotalPats({ kitties });

  return {
    [NAME]: str`${title}`,
    [UI]: (
      <os-container>
        <h1>🐱 Kitty Pat Counter 🐱</h1>
        
        <common-input
          id="title"
          value={title}
          placeholder="Name your kitty collection"
          oncommon-input={updateTitle({ title })}
        />

        {ifElse(
          kitties,
          <ul class="kitty-list">
            {kitties.map((kitty) => (
              <li class="kitty-item">
                <span class="kitty-name">{kitty.name}</span>
                <span class="kitty-pats">Pats: {kitty.pats}</span>
                <button 
                  class="pat-button"
                  onclick={patKitty({ kitty })}
                >
                  Pat Kitty 🐾
                </button>
                <button 
                  class="goodbye-button"
                  onclick={goodbyeKitty({ kitty, kitties })}
                >
                  Goodbye Kitty 😢
                </button>
              </li>
            ))}
          </ul>,
          <p><em>No kitties yet! Time to adopt some!</em></p>
        )}

        <div class="controls">
          <button 
            class="adopt-button"
            onclick={adoptKitty({ kitties })}
          >
            Adopt A Kitty 😺
          </button>
          
          <button 
            class="random-pat-button"
            onclick={patRandomKitty({ kitties })}
          >
            Pat Random Kitty 🎲
          </button>
        </div>

        <p class="total-pats">
          Total Pats Given: <span id="total">{totalPats}</span>
        </p>
      </os-container>
    ),
  };
});