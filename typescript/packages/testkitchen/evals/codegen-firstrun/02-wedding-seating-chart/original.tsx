import { h } from "@commontools/common-html";
import {
  Spell,
  type OpaqueRef,
  handler,
  select,
  $,
  derive,
  ifElse,
} from "@commontools/common-builder";

type Guest = {
  id: string;
  name: string;
  tableNumber: number; // 0 for head table, 1-10 for regular tables
};

type SeatingChart = {
  guests: Guest[];
  newGuestName: string;
};

const createGuest = (name: string): Guest => ({
  id: crypto.randomUUID(),
  name,
  tableNumber: -1, // -1 means unassigned
});

const handleAddGuest = handler<{}, { guests: Guest[]; newGuestName: string }>(
  function ({}, state) {
    if (state.newGuestName.trim()) {
      state.guests.push(createGuest(state.newGuestName.trim()));
      state.newGuestName = ""; // Clear input after adding
    }
  },
);

const handleUpdateNewGuestName = handler<
  { detail: { value: string } },
  { newGuestName: string }
>(function ({ detail: { value } }, state) {
  state.newGuestName = value;
});

const handleAssignTable = handler<
  { detail: { value: string } },
  { guest: Guest }
>(function ({ detail: { value } }, { guest }) {
  guest.tableNumber = parseInt(value, 10);
});

const handleRemoveGuest = handler<{}, { guest: Guest; guests: Guest[] }>(
  function ({}, { guest, guests }) {
    const index = guests.findIndex(g => g.id === guest.id);
    if (index !== -1) {
      guests.splice(index, 1);
    }
  },
);

const getTableGuests = (guests: Guest[], tableNumber: number) => {
  console.log("guests", guests);
  console.log("typeof guests", typeof guests);
  return guests.filter(guest => guest.tableNumber === tableNumber);
};

const getTableCapacity = (tableNumber: number) => {
  return tableNumber === 0 ? 10 : 8; // Head table has 10 seats, others have 8
};

const getTableName = (tableNumber: number) => {
  return tableNumber === 0 ? "Head Table" : `Table ${tableNumber}`;
};

export class WeddingSeatingChartSpell extends Spell<SeatingChart> {
  override init() {
    return {
      guests: [],
      newGuestName: "",
    };
  }

  override render({ guests, newGuestName }: OpaqueRef<SeatingChart>) {
    const tableNumbers = Array.from({ length: 11 }, (_, i) => i); // 0-10

    const formatTableOption = (tableNum: number) => {
      const capacity = getTableCapacity(tableNum);
      const currentGuests = getTableGuests(guests, tableNum).length;
      const remaining = capacity - currentGuests;
      return `${getTableName(tableNum)} (${currentGuests}/${capacity})`;
    };

    return (
      <div style="padding: 20px;">
        <style>
          {`
            .table-card {
              background: #f5f5f5;
              border-radius: 8px;
              padding: 16px;
              margin-bottom: 16px;
            }
            .guest-list {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
              gap: 16px;
            }
            .guest-card {
              background: white;
              border: 1px solid #ddd;
              border-radius: 4px;
              padding: 8px;
            }
            .unassigned {
              background: #fff3cd;
            }
          `}
        </style>

        <common-vstack gap="lg">
          <h1>Wedding Seating Chart</h1>

          {/* Add Guest Form */}
          <div class="table-card">
            <common-vstack gap="md">
              <h2>Add New Guest</h2>
              <common-hstack gap="md">
                <common-input
                  value={newGuestName}
                  placeholder="Enter guest name"
                  oncommon-input={handleUpdateNewGuestName.with({
                    newGuestName,
                  })}
                />
                <common-button
                  onclick={handleAddGuest.with({ guests, newGuestName })}
                >
                  Add Guest
                </common-button>
              </common-hstack>
            </common-vstack>
          </div>

          {/* Table View */}
          {tableNumbers.map(tableNum => (
            <div class="table-card">
              <h2>{getTableName(tableNum)}</h2>
              <p>
                Capacity:{" "}
                {derive(guests, guests => {
                  const currentGuests = getTableGuests(guests, tableNum).length;
                  const capacity = getTableCapacity(tableNum);
                  return `${currentGuests}/${capacity} seats filled`;
                })}
              </p>
              <div class="guest-list">
                {derive(guests, guests =>
                  getTableGuests(guests, tableNum).map(guest => (
                    <div class="guest-card">
                      <common-vstack gap="sm">
                        <common-hstack gap="md">
                          <span>{guest.name}</span>
                          <common-spacer />
                          <common-button
                            onclick={handleRemoveGuest.with({ guest, guests })}
                          >
                            Remove
                          </common-button>
                        </common-hstack>
                        <select
                          value={guest.tableNumber}
                          onchange={handleAssignTable.with({ guest })}
                        >
                          <option value={-1}>Unassigned</option>
                          {tableNumbers.map(num => (
                            <option
                              value={num}
                              disabled={derive(guests, guests => {
                                const currentGuests = getTableGuests(
                                  guests,
                                  num,
                                ).length;
                                return (
                                  currentGuests >= getTableCapacity(num) &&
                                  guest.tableNumber !== num
                                );
                              })}
                            >
                              {formatTableOption(num)}
                            </option>
                          ))}
                        </select>
                      </common-vstack>
                    </div>
                  )),
                )}
              </div>
            </div>
          ))}

          {/* Unassigned Guests */}
          <div class="table-card unassigned">
            <h2>Unassigned Guests</h2>
            <div class="guest-list">
              {derive(guests, guests =>
                getTableGuests(guests, -1).map(guest => (
                  <div class="guest-card">
                    <common-vstack gap="sm">
                      <common-hstack gap="md">
                        <span>{guest.name}</span>
                        <common-spacer />
                        <common-button
                          onclick={handleRemoveGuest.with({ guest, guests })}
                        >
                          Remove
                        </common-button>
                      </common-hstack>
                      <select
                        value={guest.tableNumber}
                        onchange={handleAssignTable.with({ guest })}
                      >
                        <option value={-1}>Unassigned</option>
                        {tableNumbers.map(num => (
                          <option
                            value={num}
                            disabled={derive(guests, guests => {
                              const currentGuests = getTableGuests(
                                guests,
                                num,
                              ).length;
                              return (
                                currentGuests >= getTableCapacity(num) &&
                                guest.tableNumber !== num
                              );
                            })}
                          >
                            {formatTableOption(num)}
                          </option>
                        ))}
                      </select>
                    </common-vstack>
                  </div>
                )),
              )}
            </div>
          </div>
        </common-vstack>
      </div>
    );
  }
}

const weddingSeatingChart = new WeddingSeatingChartSpell().compile(
  "WeddingSeatingChart",
);

export default weddingSeatingChart;
