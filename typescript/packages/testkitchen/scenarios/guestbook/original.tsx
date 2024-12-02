
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  ifElse,
} from "@commontools/common-builder";
import { z } from "zod";

// Define the schema for a guestbook entry
const GuestbookEntry = z.object({
  name: z.string(),
  message: z.string(),
  timestamp: z.number()
});
type GuestbookEntry = z.infer<typeof GuestbookEntry>;

// Define the main schema
const Schema = z.object({
  entries: z.array(GuestbookEntry).default([]),
  currentName: z.string().default(""),
  currentMessage: z.string().default("")
}).describe("Guestbook");
type Schema = z.infer<typeof Schema>;

// Handler to update the current name input
const updateName = handler<{ detail: { value: string } }, { currentName: string }>(
  ({ detail }, state) => {
    detail?.value !== undefined && (state.currentName = detail.value);
  }
);

// Handler to update the current message input
const updateMessage = handler<{ detail: { value: string } }, { currentMessage: string }>(
  ({ detail }, state) => {
    detail?.value !== undefined && (state.currentMessage = detail.value);
  }
);

// Handler to add a new entry
const addEntry = handler<{}, { entries: GuestbookEntry[], currentName: string, currentMessage: string }>(
  ({}, state) => {
    if (state.currentName.trim()) {
      state.entries.unshift({
        name: state.currentName,
        message: state.currentMessage,
        timestamp: Date.now()
      });
      // Clear inputs
      state.currentName = "";
      state.currentMessage = "";
    }
  }
);

// Lift to format the timestamp
const formatDate = lift((timestamp: number) => {
  return new Date(timestamp).toLocaleString();
});

export default recipe(Schema, ({ entries, currentName, currentMessage }) => {
  return {
    [NAME]: "Guestbook",
    [UI]: (
      <os-container>
        <h2>Sign the Guestbook</h2>
        
        <div style="margin-bottom: 20px;">
          <div style="margin-bottom: 10px;">
            <common-input
              value={currentName}
              placeholder="Your name"
              oncommon-input={updateName({ currentName })}
            />
          </div>
          
          <div style="margin-bottom: 10px;">
            <common-textarea
              value={currentMessage}
              placeholder="Leave a message (optional)"
              oncommon-input={updateMessage({ currentMessage })}
            />
          </div>

          <button 
            onclick={addEntry({ entries, currentName, currentMessage })}
            disabled={!currentName}
          >
            Sign Guestbook
          </button>
        </div>

        <h3>Entries</h3>
        {ifElse(entries,
          <div>
            {entries.map((entry) => (
              <div style="border-bottom: 1px solid #ccc; padding: 10px 0;">
                <strong>{entry.name}</strong>
                <div style="color: #666; font-size: 0.8em;">
                  {formatDate(entry.timestamp)}
                </div>
                {ifElse(entry.message,
                  <p style="margin-top: 5px;">{entry.message}</p>,
                  <span></span>
                )}
              </div>
            ))}
          </div>,
          <p><em>No entries yet. Be the first to sign!</em></p>
        )}
      </os-container>
    )
  };
});