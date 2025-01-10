import { h } from "@commontools/common-html";
import {
  Spell,
  type OpaqueRef,
  handler,
  $,
  derive,
  ifElse,
} from "@commontools/common-builder";

type Guest = {
  id: string;
  name: string;
  plusOne: boolean;
  affiliation: "Bride" | "Groom";
  description: string;
  tableId: string | null;
};

type Table = {
  id: string;
  name: string;
  capacity: number;
  guests: Guest[];
};

type WeddingSeating = {
  guests: Guest[];
  tables: Table[];
  csvContent: string;
};

const parseCSV = (csv: string): Guest[] => {
  const lines = csv.trim().split("\n");
  // Skip header row
  return lines
    .slice(1)
    .filter(line => line.trim())
    .map((line, index) => {
      const [name, plusOne, affiliation, description] = line
        .split(",")
        .map(field => field.trim());
      return {
        id: `guest-${index}`,
        name,
        plusOne: plusOne.toUpperCase() === "TRUE",
        affiliation: affiliation as "Bride" | "Groom",
        description,
        tableId: null,
      };
    });
};

const handleCSVInput = handler<
  { detail: { value: string } },
  { guests: Guest[] }
>(function ({ detail: { value } }, state) {
  try {
    state.guests = parseCSV(value);
  } catch (e) {
    console.error("Failed to parse CSV:", e);
  }
});

const handleAssignGuest = handler<
  {},
  { guest: Guest; table: Table; guests: Guest[]; tables: Table[] }
>(function ({}, { guest, table, guests, tables }) {
  // Remove guest from current table if assigned
  if (guest.tableId) {
    const currentTable = tables.find(t => t.id === guest.tableId);
    if (currentTable) {
      currentTable.guests = currentTable.guests.filter(g => g.id !== guest.id);
    }
  }

  // Check if table has capacity
  if (table.guests.length < table.capacity) {
    guest.tableId = table.id;
    table.guests.push(guest);
  }
});

const handleRemoveGuest = handler<{}, { guest: Guest; tables: Table[] }>(
  function ({}, { guest, tables }) {
    if (guest.tableId) {
      const table = tables.find(t => t.id === guest.tableId);
      if (table) {
        table.guests = table.guests.filter(g => g.id !== guest.id);
        guest.tableId = null;
      }
    }
  },
);

export class WeddingSeatingSpell extends Spell<WeddingSeating> {
  override init() {
    const tables: Table[] = [
      {
        id: "head",
        name: "Head Table",
        capacity: 10,
        guests: [],
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `table-${i + 1}`,
        name: `Table ${i + 1}`,
        capacity: 8,
        guests: [],
      })),
    ];

    return {
      guests: [],
      tables,
      csvContent: "",
    };
  }

  override render({ guests, tables, csvContent }: OpaqueRef<WeddingSeating>) {
    const getUnassignedGuests = (guests: Guest[]) => {
      return guests.filter(guest => guest.tableId === null);
    };

    const getTableCapacityString = (table: Table) => {
      return `${table.guests.length}/${table.capacity}`;
    };

    return (
      <div style="padding: 20px;">
        <style>
          {`
            .table-card {
              border: 1px solid #ccc;
              padding: 15px;
              border-radius: 8px;
              background: #f9f9f9;
            }
            .guest-list {
              max-height: 200px;
              overflow-y: auto;
            }
            .guest-item {
              padding: 8px;
              margin: 4px 0;
              background: white;
              border: 1px solid #eee;
              border-radius: 4px;
            }
            .unassigned-section {
              border: 1px solid #ffcdd2;
              background: #ffebee;
              padding: 15px;
              border-radius: 8px;
              margin-bottom: 20px;
            }
          `}
        </style>

        <common-vstack gap="xl">
          <div>
            <h2>Import Guest List</h2>
            <common-textarea
              value={csvContent}
              placeholder="Paste CSV data here..."
              rows={10}
              oncommon-input={handleCSVInput.with({ guests })}
            />
          </div>

          <div class="unassigned-section">
            <h3>Unassigned Guests</h3>
            <div class="guest-list">
              {derive(guests, guests =>
                getUnassignedGuests(guests).map(guest => (
                  <div class="guest-item">
                    <common-vstack gap="sm">
                      <strong>{guest.name}</strong>
                      <p>
                        {guest.affiliation} |{" "}
                        {ifElse(guest.plusOne, "Plus One", "No Plus One")}
                      </p>
                      <p>{guest.description}</p>
                      <common-hstack gap="md"></common-hstack>
                    </common-vstack>
                  </div>
                )),
              )}
            </div>
          </div>

          <common-grid style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
            {tables.map(table => (
              <div class="table-card">
                <common-vstack gap="md">
                  <common-hstack gap="md">
                    <h3>{table.name}</h3>
                    <span>
                      {derive(table, table => getTableCapacityString(table))}
                    </span>
                  </common-hstack>
                  <div class="guest-list">
                    {table.guests.map(guest => (
                      <div class="guest-item">
                        <common-vstack gap="sm">
                          <strong>{guest.name}</strong>
                          <p>
                            {guest.affiliation} |{" "}
                            {ifElse(guest.plusOne, "Plus One", "No Plus One")}
                          </p>
                          <common-button
                            onclick={handleRemoveGuest.with({ guest, tables })}
                          >
                            Remove
                          </common-button>
                        </common-vstack>
                      </div>
                    ))}
                  </div>
                </common-vstack>
              </div>
            ))}
          </common-grid>
        </common-vstack>
      </div>
    );
  }
}

const weddingSeating = new WeddingSeatingSpell().compile("WeddingSeating");

export default weddingSeating;
