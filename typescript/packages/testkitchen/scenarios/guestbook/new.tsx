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

// Define schema for a guestbook entry
const Entry = z.object({
  name: z.string(),
  timestamp: z.string(),
});
type Entry = z.infer<typeof Entry>;

// Define schema for the guestbook state
const Schema = z
  .object({
    entries: z.array(Entry).default([]),
    currentName: z.string().default(""),
  })
  .describe("Hello Kitty Guestbook");
type Schema = z.infer<typeof Schema>;

// Handler to update the current name input
const updateName = handler<
  { detail: { value: string } },
  { currentName: string }
>(({ detail }, state) => {
  detail?.value && (state.currentName = detail.value);
});

// Handler to add a new guestbook entry
const addEntry = handler<{}, { entries: Entry[]; currentName: string }>(
  ({}, state) => {
    if (state.currentName.trim()) {
      state.entries.unshift({
        name: state.currentName,
        timestamp: new Date().toISOString(),
      });
      state.currentName = "";
    }
  },
);

// Lift to format the timestamp
const formatDate = lift((dateStr: string) => {
  return new Date(dateStr).toLocaleString();
});

// Styles as strings
const containerStyle = `
  background-color: #fff0f5;
  border: 3px solid #ff69b4;
  border-radius: 15px;
  padding: 20px;
  max-width: 600px;
  margin: 20px auto;
  font-family: 'Comic Sans MS', cursive;
`;

const headerStyle = `
  color: #ff69b4;
  text-align: center;
  margin-bottom: 20px;
`;

const inputContainerStyle = `
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
  justify-content: center;
`;

const buttonStyle = `
  background-color: #ff69b4;
  color: white;
  border: none;
  border-radius: 20px;
  padding: 10px 20px;
  cursor: pointer;
  font-family: 'Comic Sans MS', cursive;
  transition: transform 0.2s;
`;

const entryListStyle = `
  list-style: none;
  padding: 0;
`;

const entryItemStyle = `
  background-color: white;
  border: 2px solid #ff69b4;
  border-radius: 10px;
  padding: 10px;
  margin-bottom: 10px;
  box-shadow: 0 2px 4px rgba(255, 105, 180, 0.2);
`;

const inputStyle = `
  border: 2px solid #ff69b4;
  border-radius: 20px;
  padding: 8px 15px;
  font-family: 'Comic Sans MS', cursive;
  outline: none;
`;

export default recipe(Schema, ({ entries, currentName }) => {
  return {
    [NAME]: "Hello Kitty Guestbook",
    [UI]: (
      <os-container style={containerStyle}>
        <div style={headerStyle}>
          <h2>✿ Hello Kitty Guestbook ✿</h2>
          <p>♡ Leave your pawprint! ♡</p>
        </div>

        <div style={inputContainerStyle}>
          <common-input
            value={currentName}
            placeholder="Your name here..."
            style={inputStyle}
            oncommon-input={updateName({ currentName })}
          />
          <button
            onclick={addEntry({ entries, currentName })}
            style={buttonStyle}
          >
            ♡ Sign Guestbook ♡
          </button>
        </div>

        <h3 style={headerStyle}>✧ Sweet Messages ✧</h3>
        {ifElse(
          entries,
          <ul style={entryListStyle}>
            {entries.map(entry => (
              <li style={entryItemStyle}>
                <span style="color: #ff69b4;">♡</span>{" "}
                <strong>{entry.name}</strong>
                <br />
                <small style="color: #999;">
                  visited on {formatDate(entry.timestamp)}
                </small>
              </li>
            ))}
          </ul>,
          <p style="text-align: center; color: #ff69b4;">
            <em>No entries yet. Be the first to leave a sweet message! ♡</em>
          </p>,
        )}
      </os-container>
    ),
  };
});
