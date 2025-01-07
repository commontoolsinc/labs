import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
} from "@commontools/common-builder";
import { z } from "zod";

const Guest = z.object({
  name: z.string(),
  plusOne: z.boolean(),
  affiliation: z.string(),
  description: z.string(),
});
type Guest = z.infer<typeof Guest>;

const Schema = z
  .object({
    guests: z.array(Guest).default([]),
    headTable: z.array(Guest).default([]),
    tables: z.array(z.array(Guest)).default([]),
  })
  .describe("Wedding Seating Chart");
type Schema = z.infer<typeof Schema>;

const addGuestToHeadTable = handler<{}, { Guest; headTable: Guest[] }>(
  ({}, state) => {
    if (state.headTable.length < 10) {
      state.headTable.push(state.guest);
    }
  },
);

const addGuestToTable = handler<
  { tableIndex: number },
  { guest: Guest; tables: Guest[][] }
>(
  ({ tableIndex }, state) => {
    if (state.tables[tableIndex].length < 8) {
      state.tables[tableIndex].push(state.guest);
    }
  },
);

const removeGuestFromHeadTable = handler<
  {},
  { guest: Guest; headTable: Guest[] }
>(
  ({}, state) => {
    const index = state.headTable.findIndex((g) => g.name === state.guest.name);
    if (index !== -1) {
      state.headTable.splice(index, 1);
    }
  },
);

const removeGuestFromTable = handler<
  { tableIndex: number },
  { guest: Guest; tables: Guest[][] }
>(
  ({ tableIndex }, state) => {
    const index = state.tables[tableIndex].findIndex(
      (g) => g.name === state.guest.name,
    );
    if (index !== -1) {
      state.tables[tableIndex].splice(index, 1);
    }
  },
);

const parseCSV = lift((csv: string) => {
  const guests: Guest[] = [];
  const rows = csv.split("\n");
  for (const row of rows) {
    const columns = row.split(",");
    if (columns.length === 4) {
      guests.push({
        name: columns[0],
        plusOne: columns[1].toLowerCase() === "true",
        affiliation: columns[2],
        description: columns[3],
      });
    }
  }
  return guests;
});

const getAvailableTables = lift((tables: Guest[][]) => {
  const availableTables: number[] = [];
  for (let i = 0; i < tables.length; i++) {
    if (tables[i].length < 8) {
      availableTables.push(i);
    }
  }
  return availableTables;
});

export default recipe(Schema, ({ guests, headTable, tables }) => {
  const availableTables = getAvailableTables({ tables });

  return {
    [NAME]: str`Wedding Seating Chart`,
    [UI]: (
      <os-container>
        <common-textarea
          placeholder="Paste CSV of guests"
          oncommon-input={parseCSV}
        />
        <h2>Head Table</h2>
        <ul>
          {headTable.map((guest) => (
            <li>
              {guest.name}
              <button
                onclick={removeGuestFromHeadTable({ guest, headTable })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <h2>Tables</h2>
        {tables.map((table, index) => (
          <div key={index}>
            <h3>Table {index + 1}</h3>
            <ul>
              {table.map((guest) => (
                <li>
                  {guest.name}
                  <button
                    onclick={removeGuestFromTable({ guest, tableIndex: index })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <h2>Available Guests</h2>
        <ul>
          {guests.map((guest) => (
            <li>
              {guest.name}
              <button
                onclick={addGuestToHeadTable({ guest, headTable })}
              >
                Add to Head Table
              </button>
              {availableTables.map((tableIndex) => (
                <button
                  onclick={addGuestToTable({ guest, tableIndex })}
                >
                  Add to Table {tableIndex + 1}
                </button>
              ))}
            </li>
          ))}
        </ul>
      </os-container>
    ),
  };
});