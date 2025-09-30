/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface NamedCounter {
  id: string;
  label: string;
  value: number;
}

interface SearchFilterArgs {
  counters: Default<NamedCounter[], []>;
  search: Default<string, "">;
}

interface CounterUpdateEvent {
  id?: string;
  delta?: number;
  value?: number;
  label?: string;
}

const sanitizeCounterList = (
  entries: readonly NamedCounter[] | undefined,
): NamedCounter[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const safeId = typeof entry?.id === "string" && entry.id.trim()
      ? entry.id
      : `counter-${index}`;
    const safeLabel = typeof entry?.label === "string" && entry.label.trim()
      ? entry.label
      : `Counter ${index + 1}`;
    const rawValue = entry?.value;
    const safeValue = typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : 0;
    return { id: safeId, label: safeLabel, value: safeValue };
  });
};

const sanitizeSearchTerm = (input: string | undefined): string => {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, 64);
};

const setSearchTerm = handler(
  (
    event: { term?: string; query?: string } | string | undefined,
    context: { search: Cell<string> },
  ) => {
    const raw = typeof event === "string" ? event : event?.term ?? event?.query;
    const sanitized = sanitizeSearchTerm(raw);
    context.search.set(sanitized);
  },
);

const resetSearchTerm = handler(
  (_event: unknown, context: { search: Cell<string> }) => {
    context.search.set("");
  },
);

const updateCounterValue = handler(
  (
    event: CounterUpdateEvent | undefined,
    context: { counters: Cell<NamedCounter[]> },
  ) => {
    const list = sanitizeCounterList(context.counters.get());
    if (list.length === 0) return;

    const fallbackId = list[0]?.id;
    const targetId = typeof event?.id === "string" && event.id.trim()
      ? event.id
      : fallbackId;
    if (!targetId) return;

    const hasValue = typeof event?.value === "number" &&
      Number.isFinite(event.value);
    const delta = typeof event?.delta === "number" &&
        Number.isFinite(event.delta)
      ? event.delta
      : 0;
    const nextLabel = typeof event?.label === "string" &&
        event.label.trim()
      ? event.label
      : undefined;

    const updated = list.map((item) => {
      if (item.id !== targetId) return item;
      const base = hasValue ? event.value! : item.value + delta;
      const safeValue = Number.isFinite(base) ? base : item.value;
      return {
        id: item.id,
        label: nextLabel ?? item.label,
        value: safeValue,
      };
    });

    context.counters.set(updated);
  },
);

export const counterWithSearchTermFilterUx = recipe<SearchFilterArgs>(
  "Counter With Search Term Filter (UX)",
  ({ counters, search }) => {
    const sanitizedCounters = lift(sanitizeCounterList)(counters);
    const searchTerm = lift(sanitizeSearchTerm)(search);
    const searchDisplay = lift((term: string) =>
      term.length > 0 ? term : "(all)"
    )(searchTerm);

    const filteringInputs = {
      values: sanitizedCounters,
      term: searchTerm,
    };

    const filtered = lift(
      (
        input: { values: NamedCounter[]; term: string },
      ): NamedCounter[] => {
        const query = input.term.toLowerCase();
        if (!query) return input.values;
        return input.values.filter((item) =>
          item.label.toLowerCase().includes(query)
        );
      },
    )(filteringInputs);

    const totalCount = lift((values: NamedCounter[]) => values.length)(
      sanitizedCounters,
    );
    const filteredCount = lift((values: NamedCounter[]) => values.length)(
      filtered,
    );
    const hasMatches = lift((count: number) => count > 0)(filteredCount);

    const filteredLabels = lift((entries: NamedCounter[]) =>
      entries.map((entry) => `${entry.label} (${entry.value})`)
    )(filtered);

    const summary =
      str`Matches ${filteredCount}/${totalCount} for ${searchDisplay}`;

    // UI state cells
    const searchField = cell<string>("");
    const counterIdField = cell<string>("");
    const deltaField = cell<string>("");
    const labelField = cell<string>("");
    const valueField = cell<string>("");
    const addLabelField = cell<string>("");
    const addValueField = cell<string>("");

    // UI handler to set search
    const setSearchUI = handler(
      (_event: unknown, context: {
        search: Cell<string>;
        searchField: Cell<string>;
      }) => {
        const term = context.searchField.get();
        if (typeof term !== "string") return;
        const sanitized = sanitizeSearchTerm(term);
        context.search.set(sanitized);
      },
    );

    // UI handler to clear search
    const clearSearchUI = handler(
      (_event: unknown, context: {
        search: Cell<string>;
        searchField: Cell<string>;
      }) => {
        context.search.set("");
        context.searchField.set("");
      },
    );

    // UI handler to increment counter
    const incrementCounterUI = handler(
      (_event: unknown, context: {
        counters: Cell<NamedCounter[]>;
        counterIdField: Cell<string>;
        deltaField: Cell<string>;
      }) => {
        const idStr = context.counterIdField.get();
        const deltaStr = context.deltaField.get();

        if (
          typeof idStr !== "string" || idStr.trim() === "" ||
          typeof deltaStr !== "string" || deltaStr.trim() === ""
        ) {
          return;
        }

        const id = idStr.trim();
        const delta = Number(deltaStr);
        if (!Number.isFinite(delta)) return;

        const list = sanitizeCounterList(context.counters.get());
        const updated = list.map((item) => {
          if (item.id !== id) return item;
          return { ...item, value: item.value + delta };
        });

        context.counters.set(updated);
        context.counterIdField.set("");
        context.deltaField.set("");
      },
    );

    // UI handler to set counter value
    const setCounterValueUI = handler(
      (_event: unknown, context: {
        counters: Cell<NamedCounter[]>;
        counterIdField: Cell<string>;
        valueField: Cell<string>;
      }) => {
        const idStr = context.counterIdField.get();
        const valueStr = context.valueField.get();

        if (
          typeof idStr !== "string" || idStr.trim() === "" ||
          typeof valueStr !== "string" || valueStr.trim() === ""
        ) {
          return;
        }

        const id = idStr.trim();
        const value = Number(valueStr);
        if (!Number.isFinite(value)) return;

        const list = sanitizeCounterList(context.counters.get());
        const updated = list.map((item) => {
          if (item.id !== id) return item;
          return { ...item, value };
        });

        context.counters.set(updated);
        context.counterIdField.set("");
        context.valueField.set("");
      },
    );

    // UI handler to update label
    const updateLabelUI = handler(
      (_event: unknown, context: {
        counters: Cell<NamedCounter[]>;
        counterIdField: Cell<string>;
        labelField: Cell<string>;
      }) => {
        const idStr = context.counterIdField.get();
        const labelStr = context.labelField.get();

        if (
          typeof idStr !== "string" || idStr.trim() === "" ||
          typeof labelStr !== "string" || labelStr.trim() === ""
        ) {
          return;
        }

        const id = idStr.trim();
        const label = labelStr.trim();

        const list = sanitizeCounterList(context.counters.get());
        const updated = list.map((item) => {
          if (item.id !== id) return item;
          return { ...item, label };
        });

        context.counters.set(updated);
        context.counterIdField.set("");
        context.labelField.set("");
      },
    );

    // UI handler to add counter
    const addCounterUI = handler(
      (_event: unknown, context: {
        counters: Cell<NamedCounter[]>;
        addLabelField: Cell<string>;
        addValueField: Cell<string>;
      }) => {
        const labelStr = context.addLabelField.get();
        const valueStr = context.addValueField.get();

        if (typeof labelStr !== "string" || labelStr.trim() === "") {
          return;
        }

        const label = labelStr.trim();
        const value = typeof valueStr === "string" && valueStr.trim() !== ""
          ? Number(valueStr)
          : 0;
        if (!Number.isFinite(value)) return;

        const list = sanitizeCounterList(context.counters.get());
        const id = `counter-${Date.now()}`;
        const newCounter: NamedCounter = { id, label, value };

        context.counters.set([...list, newCounter]);
        context.addLabelField.set("");
        context.addValueField.set("");
      },
    );

    const name = lift((inputs: {
      term: string;
      matches: number;
      total: number;
    }) => {
      const term = inputs.term || "(all)";
      return `Search: ${term} (${inputs.matches}/${inputs.total})`;
    })({ term: searchTerm, matches: filteredCount, total: totalCount });

    const filteredDisplay = lift((entries: NamedCounter[]) => {
      if (entries.length === 0) {
        return h(
          "div",
          {
            style: "background: #fef2f2; border: 2px dashed #fca5a5; " +
              "border-radius: 12px; padding: 32px; text-align: center;",
          },
          h(
            "p",
            { style: "color: #dc2626; font-size: 16px; margin: 0;" },
            "No matching counters found",
          ),
        );
      }

      const counterElements = [];
      for (let i = 0; i < entries.length; i++) {
        const counter = entries[i];
        const card = h(
          "div",
          {
            style: "background: white; border: 2px solid #10b981; " +
              "border-radius: 12px; padding: 16px; " +
              "display: flex; flex-direction: column; gap: 8px;",
          },
          h(
            "div",
            {
              style: "display: flex; justify-content: space-between; " +
                "align-items: center;",
            },
            h(
              "div",
              { style: "display: flex; flex-direction: column; gap: 4px;" },
              h(
                "span",
                {
                  style: "font-size: 16px; font-weight: 700; color: #1e293b;",
                },
                counter.label,
              ),
              h(
                "span",
                {
                  style: "font-size: 11px; color: #94a3b8; " +
                    "font-family: monospace;",
                },
                "ID: " + counter.id,
              ),
            ),
            h(
              "span",
              {
                style: "font-size: 36px; font-weight: 900; color: #10b981; " +
                  "font-family: monospace;",
              },
              String(counter.value),
            ),
          ),
        );
        counterElements.push(card);
      }

      return h(
        "div",
        {
          style: "display: grid; " +
            "grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); " +
            "gap: 16px;",
        },
        ...counterElements,
      );
    })(filtered);

    const ui = (
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "20px",
          background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "28px",
              color: "#1e293b",
              fontWeight: "700",
            }}
          >
            Counter Search & Filter
          </h1>
          <p
            style={{
              margin: "0 0 24px 0",
              color: "#64748b",
              fontSize: "14px",
            }}
          >
            Search and filter named counters by label
          </p>

          <div
            style={{
              background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
              borderRadius: "12px",
              padding: "24px",
              marginBottom: "24px",
            }}
          >
            <div
              style={{
                fontSize: "20px",
                fontWeight: "700",
                color: "white",
                textAlign: "center",
                marginBottom: "16px",
              }}
            >
              {summary}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: "12px",
              }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,0.2)",
                  borderRadius: "8px",
                  padding: "12px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.8)",
                    marginBottom: "4px",
                  }}
                >
                  TOTAL COUNTERS
                </div>
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "800",
                    color: "white",
                    fontFamily: "monospace",
                  }}
                >
                  {totalCount}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(255,255,255,0.2)",
                  borderRadius: "8px",
                  padding: "12px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.8)",
                    marginBottom: "4px",
                  }}
                >
                  MATCHES
                </div>
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: "800",
                    color: "white",
                    fontFamily: "monospace",
                  }}
                >
                  {filteredCount}
                </div>
              </div>
            </div>
          </div>

          <h2
            style={{
              fontSize: "18px",
              color: "#1e293b",
              margin: "0 0 12px 0",
              fontWeight: "600",
            }}
          >
            🔍 Search
          </h2>
          <div style={{ display: "flex", gap: "12px", marginBottom: "24px" }}>
            <ct-input
              $value={searchField}
              placeholder="Search by label..."
              style={{
                flex: "1",
                padding: "12px",
                border: "2px solid #e2e8f0",
                borderRadius: "8px",
                fontSize: "14px",
              }}
            />
            <ct-button
              onClick={setSearchUI({ search, searchField })}
              style={{
                padding: "12px 24px",
                background: "#10b981",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Search
            </ct-button>
            <ct-button
              onClick={clearSearchUI({ search, searchField })}
              style={{
                padding: "12px 24px",
                background: "#6b7280",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Clear
            </ct-button>
          </div>

          <h2
            style={{
              fontSize: "18px",
              color: "#1e293b",
              margin: "0 0 12px 0",
              fontWeight: "600",
            }}
          >
            📊 Filtered Results
          </h2>
          {filteredDisplay}
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
          }}
        >
          <h3
            style={{
              margin: "0 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
            }}
          >
            ➕ Add Counter
          </h3>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Label
              </label>
              <ct-input
                $value={addLabelField}
                placeholder="e.g., Page Views"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Initial Value (optional, defaults to 0)
              </label>
              <ct-input
                $value={addValueField}
                placeholder="e.g., 100"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <ct-button
              onClick={addCounterUI({ counters, addLabelField, addValueField })}
              style={{
                width: "100%",
                padding: "12px",
                background: "#10b981",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Add Counter
            </ct-button>
          </div>
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
          }}
        >
          <h3
            style={{
              margin: "0 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
            }}
          >
            ⚙️ Modify Counter
          </h3>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Counter ID
              </label>
              <ct-input
                $value={counterIdField}
                placeholder="Enter counter ID from the list above"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    marginBottom: "6px",
                    fontWeight: "600",
                    color: "#475569",
                    fontSize: "13px",
                  }}
                >
                  Increment By
                </label>
                <ct-input
                  $value={deltaField}
                  placeholder="e.g., 5 or -3"
                  style={{
                    width: "100%",
                    padding: "10px",
                    border: "2px solid #e2e8f0",
                    borderRadius: "8px",
                    fontSize: "14px",
                  }}
                />
                <ct-button
                  onClick={incrementCounterUI({
                    counters,
                    counterIdField,
                    deltaField,
                  })}
                  style={{
                    width: "100%",
                    padding: "10px",
                    background: "#3b82f6",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    fontWeight: "600",
                    cursor: "pointer",
                    fontSize: "13px",
                    marginTop: "8px",
                  }}
                >
                  Increment
                </ct-button>
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    marginBottom: "6px",
                    fontWeight: "600",
                    color: "#475569",
                    fontSize: "13px",
                  }}
                >
                  Set Value To
                </label>
                <ct-input
                  $value={valueField}
                  placeholder="e.g., 100"
                  style={{
                    width: "100%",
                    padding: "10px",
                    border: "2px solid #e2e8f0",
                    borderRadius: "8px",
                    fontSize: "14px",
                  }}
                />
                <ct-button
                  onClick={setCounterValueUI({
                    counters,
                    counterIdField,
                    valueField,
                  })}
                  style={{
                    width: "100%",
                    padding: "10px",
                    background: "#8b5cf6",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    fontWeight: "600",
                    cursor: "pointer",
                    fontSize: "13px",
                    marginTop: "8px",
                  }}
                >
                  Set Value
                </ct-button>
              </div>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Update Label
              </label>
              <ct-input
                $value={labelField}
                placeholder="New label..."
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
              <ct-button
                onClick={updateLabelUI({
                  counters,
                  counterIdField,
                  labelField,
                })}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: "#f59e0b",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: "600",
                  cursor: "pointer",
                  fontSize: "13px",
                  marginTop: "8px",
                }}
              >
                Update Label
              </ct-button>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      counters,
      search,
      sanitizedCounters,
      searchTerm,
      searchDisplay,
      totalCount,
      filtered,
      filteredCount,
      filteredLabels,
      summary,
      hasMatches,
      setSearch: setSearchTerm({ search }),
      resetSearch: resetSearchTerm({ search }),
      updateCounter: updateCounterValue({ counters }),
    };
  },
);
