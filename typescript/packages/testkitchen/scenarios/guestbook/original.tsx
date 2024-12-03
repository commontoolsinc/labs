
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
} from "@commontools/common-builder";
import { z } from "zod";

// Define schema for a guestbook entry
const Entry = z.object({
  name: z.string(),
  timestamp: z.string() 
});
type Entry = z.infer<typeof Entry>;

// Define schema for the guestbook state
const Schema = z.object({
  entries: z.array(Entry).default([]),
  currentName: z.string().default("")
}).describe("Guestbook");
type Schema = z.infer<typeof Schema>;

// Handler to update the current name input
const updateName = handler<{ detail: { value: string }}, { currentName: string }>(
  ({ detail }, state) => {
    detail?.value && (state.currentName = detail.value);
  }
);

// Handler to add a new guestbook entry
const addEntry = handler<{}, { entries: Entry[], currentName: string }>(
  ({}, state) => {
    if (state.currentName.trim()) {
      state.entries.unshift({
        name: state.currentName,
        timestamp: new Date().toISOString()
      });
      state.currentName = "";
    }
  }
);

// Lift to format the timestamp
const formatDate = lift((dateStr: string) => {
  return new Date(dateStr).toLocaleString();
});

export default recipe(Schema, ({ entries, currentName }) => {
  return {
    [NAME]: "Guestbook",
    [UI]: (
      <os-container>
        <h2>Sign the Guestbook</h2>
        
        <div>
          <common-input
            value={currentName}
            placeholder="Enter your name"
            oncommon-input={updateName({ currentName })}
          />
          <button onclick={addEntry({ entries, currentName })}>
            Sign Guestbook
          </button>
        </div>

        <h3>Entries</h3>
        {ifElse(
          entries,
          <ul>
            {entries.map((entry) => (
              <li>
                <strong>{entry.name}</strong> signed on {formatDate(entry.timestamp)}
              </li>
            ))}
          </ul>,
          <p><em>No entries yet. Be the first to sign!</em></p>
        )}
      </os-container>
    )
  };
});