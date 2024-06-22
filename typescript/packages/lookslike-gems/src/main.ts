import { createRxDatabase, addRxPlugin } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { html, render } from "lit-html";
import { RxDBStatePlugin } from "rxdb/plugins/state";
import { Observable } from "rxjs";

addRxPlugin(RxDBStatePlugin);
// addRxPlugin(RxDBDevModePlugin);

// Define the schema for your database
const schema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: {
      type: "string",
      maxLength: 100,
    },
    value: {
      type: "object",
    },
  },
  required: ["id", "value"],
};

// Create the database
async function createDatabase() {
  const db = await createRxDatabase({
    name: "inventorydb",
    storage: getRxStorageMemory(),
  });

  await db.addCollections({
    inventory: {
      schema: schema,
    },
  });

  return db;
}

// Create a data orb component
function DataOrb(props: { id: string; value: any }) {
  return html`
    <div class="data-orb">
      <h3>${props.id}</h3>
      <p>${JSON.stringify(props.value)}</p>
    </div>
  `;
}

const initial = {
  health: 100,
  mana: 50,
  gold: 1000,
  items: ["sword", "shield"],
  skills: {
    strength: 10,
    agility: 8,
    intelligence: 12,
  },
  quests: ["Defeat the dragon", "Find the treasure"],
  level: 5,
};

type Inventory = typeof initial;

// Main application
async function main() {
  const db = await createDatabase();
  const state = await db.addState();

  // Insert some initial data
  await state.set("inventory", (_) => initial);
  const inventory = state.get$("inventory") as Observable<Inventory | null>;

  // Subscribe to changes
  inventory.subscribe((stateData) => {
    const app = html`
      <style>
        .inventory-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 20px;
          padding: 20px;
        }
        .data-orb {
          background-color: rgba(0, 100, 200, 0.7);
          border-radius: 50%;
          padding: 20px;
          text-align: center;
          color: white;
          transition: transform 0.3s ease;
        }
        .data-orb:hover {
          transform: scale(1.1);
        }
      </style>
      <h1>Inventory Data Orbs</h1>
      <div class="inventory-grid">
        ${!stateData
          ? html`<p>Loading...</p>`
          : Object.entries(stateData).map(([key, value]) =>
              DataOrb({ id: key, value }),
            )}
      </div>
    `;
    render(app, document.body);
  });

  // Example of updating state
  setInterval(() => {
    state.set("inventory.health", (v) => v - 10);
  }, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  main().catch(console.error);
});
