/**
 * Fair Share — a shared expense ledger.
 *
 * Track who paid for what in a group, split each expense among the people who
 * shared it, and see net balances plus a minimal "settle up" plan of who should
 * pay whom. Inspired by group expense-splitting apps.
 *
 * Scope (cozy-poll idiom):
 * - `people` and `expenses` are a per-space shared ledger anyone in the space
 *   sees and edits.
 * - `myName` is per-user: each viewer picks which person they are, which powers
 *   a personal "you are owed / you owe" summary and row highlight.
 * - Form drafts are per-session local cells, so concurrent viewers don't share
 *   each other's half-typed input or chip toggles.
 *
 * Money is computed in integer cents with largest-remainder allocation, so
 * displayed shares always sum back to the total and balances tie out exactly.
 */
import {
  computed,
  Default,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  UI,
  Writable,
} from "commonfabric";

// ============ TYPES ============

interface Person {
  id: string;
  name: string;
}

interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string; // Person.id
  sharedBy: string[]; // Person.id[]; empty => split among everyone
  date: string; // YYYY-MM-DD
}

interface Balance {
  id: string;
  name: string;
  paid: number;
  share: number;
  net: number; // paid - share; positive => is owed, negative => owes
}

interface Settlement {
  fromId: string;
  from: string; // debtor name
  toId: string;
  to: string; // creditor name
  amount: number;
}

// Per-space shared ledger + per-user identity. Writes go through the
// module-scope handlers below (which re-type these as Writable cells).
interface State {
  people: PerSpace<Person[] | Default<[]>>;
  expenses: PerSpace<Expense[] | Default<[]>>;
  myName: PerUser<string | Default<"">>;
}

// Cell aliases for handler contexts (cozy-poll idiom).
type PeopleCell = Writable<Person[] | Default<[]>>;
type ExpensesCell = Writable<Expense[] | Default<[]>>;
type TextCell = Writable<string>;
type IdsCell = Writable<string[]>;

type EmptyEvent = Record<string, never>;
interface IdEvent {
  id: string;
}

// ============ HELPERS ============

const newId = (prefix: string): string =>
  `${prefix}_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

const getTodayDate = (): string =>
  new Date(safeDateNow()).toISOString().split("T")[0];

const toCents = (n: number): number => Math.round((n || 0) * 100);

const money = (n: number): string => `$${(n || 0).toFixed(2)}`;

// Allocate `cents` across `ids` so the parts sum back to `cents` exactly.
// Largest-remainder: the first `remainder` ids get one extra cent.
const splitCents = (cents: number, ids: string[]): Map<string, number> => {
  const out = new Map<string, number>();
  const n = ids.length;
  if (n === 0) return out;
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;
  ids.forEach((id, i) => out.set(id, base + (i < remainder ? 1 : 0)));
  return out;
};

const computeSettlements = (balances: Balance[]): Settlement[] => {
  const creditors = balances
    .map((b) => ({ id: b.id, name: b.name, rem: Math.round(b.net * 100) }))
    .filter((b) => b.rem > 0)
    .sort((a, b) => b.rem - a.rem);
  const debtors = balances
    .map((b) => ({ id: b.id, name: b.name, rem: -Math.round(b.net * 100) }))
    .filter((b) => b.rem > 0)
    .sort((a, b) => b.rem - a.rem);

  const result: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const cents = Math.min(d.rem, c.rem);
    if (cents > 0) {
      result.push({
        fromId: d.id,
        from: d.name,
        toId: c.id,
        to: c.name,
        amount: cents / 100,
      });
    }
    d.rem -= cents;
    c.rem -= cents;
    if (d.rem === 0) i++;
    if (c.rem === 0) j++;
  }
  return result;
};

// ============ HANDLERS (module scope; write per-space state) ============

const addPerson = handler<EmptyEvent, { people: PeopleCell; draft: TextCell }>(
  (_event, { people, draft }) => {
    const name = draft.get().trim();
    if (!name) return;
    if (people.get().some((p) => p.name === name)) return;
    people.push({ id: newId("p"), name });
    draft.set("");
  },
);

// Removing a person cascade-cleans the ledger so balances stay zero-sum:
// expenses they *paid* are dropped (the money has no creditor anymore), and
// they are removed from every other expense's `sharedBy` (dropping any expense
// left with no sharers).
const removePerson = handler<
  IdEvent,
  { people: PeopleCell; expenses: ExpensesCell }
>(({ id }, { people, expenses }) => {
  const ppl = people.get();
  const idx = ppl.findIndex((p) => p.id === id);
  if (idx < 0) return;
  people.set(ppl.toSpliced(idx, 1));

  const cleaned = expenses.get()
    .filter((e) => e.paidBy !== id)
    .map((e) => {
      const sharedBy = e.sharedBy.filter((s) => s !== id);
      return sharedBy.length === e.sharedBy.length ? e : { ...e, sharedBy };
    })
    .filter((e) => e.sharedBy.length > 0);
  expenses.set(cleaned);
});

const addExpense = handler<EmptyEvent, {
  people: PeopleCell;
  expenses: ExpensesCell;
  descDraft: TextCell;
  amountDraft: TextCell;
  paidByDraft: TextCell;
  splitWith: IdsCell;
}>(
  (
    _event,
    { people, expenses, descDraft, amountDraft, paidByDraft, splitWith },
  ) => {
    const description = descDraft.get().trim();
    const amount = toCents(parseFloat(amountDraft.get())) / 100; // snap to cents
    const paidBy = paidByDraft.get();
    const ppl = people.get();
    if (!description || isNaN(amount) || amount <= 0) return;
    if (!ppl.some((p) => p.id === paidBy)) return; // payer must exist

    const everyone = ppl.map((p) => p.id);
    const selected = splitWith.get().filter((sid) =>
      ppl.some((p) => p.id === sid)
    );
    const sharedBy = selected.length === 0 ? everyone : selected;
    if (sharedBy.length === 0) return;

    expenses.push({
      id: newId("e"),
      description,
      amount,
      paidBy,
      sharedBy,
      date: getTodayDate(),
    });
    descDraft.set("");
    amountDraft.set("");
    splitWith.set([]);
  },
);

const removeExpense = handler<IdEvent, { expenses: ExpensesCell }>(
  ({ id }, { expenses }) => {
    const cur = expenses.get();
    const idx = cur.findIndex((e) => e.id === id);
    if (idx >= 0) expenses.set(cur.toSpliced(idx, 1));
  },
);

const toggleSplit = handler<
  IdEvent,
  { people: PeopleCell; splitWith: IdsCell }
>(
  ({ id }, { people, splitWith }) => {
    const cur = splitWith.get();
    // First explicit toggle starts from "everyone selected".
    const base = cur.length === 0 ? people.get().map((p) => p.id) : cur;
    splitWith.set(
      base.includes(id) ? base.filter((x) => x !== id) : [...base, id],
    );
  },
);

// ============ PATTERN ============

export default pattern<State>(({ people, expenses, myName }) => {
  // --- Per-session form drafts (local to each viewer) ---
  const personDraft = Writable.perSession.of<string>("");
  const descDraft = Writable.perSession.of<string>("");
  const amountDraft = Writable.perSession.of<string>("");
  const paidByDraft = Writable.perSession.of<string>("");
  const splitWith = Writable.perSession.of<string[]>([]);

  // --- Bound handlers ---
  const boundAddPerson = addPerson({ people, draft: personDraft });
  const boundRemovePerson = removePerson({ people, expenses });
  const boundAddExpense = addExpense({
    people,
    expenses,
    descDraft,
    amountDraft,
    paidByDraft,
    splitWith,
  });
  const boundRemoveExpense = removeExpense({ expenses });
  const boundToggleSplit = toggleSplit({ people, splitWith });

  // --- Identity (resolve per-user name once at top level) ---
  const me = (myName ?? "").trim();

  // --- Derived data ---
  const payerOptions = computed(() =>
    people.map((p) => ({ label: p.name, value: p.id }))
  );
  const identityOptions = computed(() =>
    people.map((p) => ({ label: p.name, value: p.name }))
  );

  const total = computed(() => {
    let cents = 0;
    for (const e of expenses) cents += toCents(e.amount);
    return cents / 100;
  });

  const nameById = computed(() => {
    const map: Record<string, string> = {};
    for (const p of people) map[p.id] = p.name;
    return map;
  });

  const balances = computed<Balance[]>(() => {
    const paidCents = new Map<string, number>();
    const shareCents = new Map<string, number>();
    for (const p of people) {
      paidCents.set(p.id, 0);
      shareCents.set(p.id, 0);
    }

    for (const e of expenses) {
      const cents = toCents(e.amount);
      if (paidCents.has(e.paidBy)) {
        paidCents.set(e.paidBy, paidCents.get(e.paidBy)! + cents);
      }
      const everyone = people.map((p) => p.id);
      const ids = (e.sharedBy && e.sharedBy.length ? e.sharedBy : everyone)
        .filter((id) => shareCents.has(id));
      if (ids.length === 0) continue;
      const alloc = splitCents(cents, ids);
      for (const id of ids) {
        shareCents.set(id, shareCents.get(id)! + (alloc.get(id) ?? 0));
      }
    }

    return people.map((p) => {
      const paid = (paidCents.get(p.id) ?? 0) / 100;
      const share = (shareCents.get(p.id) ?? 0) / 100;
      return { id: p.id, name: p.name, paid, share, net: paid - share };
    });
  });

  const settlements = computed(() => computeSettlements(balances));

  const myNet = computed(() => {
    if (!me) return null;
    const mine = balances.find((b) => b.name === me);
    return mine ? mine.net : null;
  });

  // Display helper for the "split with" chips in the form.
  const splitChips = computed(() =>
    people.map((p) => ({
      id: p.id,
      name: p.name,
      included: splitWith.get().length === 0 || splitWith.get().includes(p.id),
    }))
  );

  return {
    [NAME]: "Fair Share",
    [UI]: (
      <cf-vstack gap="4" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-heading level={2}>Fair Share</cf-heading>
        <cf-text tone="muted">
          A shared ledger for group expenses — track who paid, split fairly, and
          settle up.
        </cf-text>

        {/* ===== You ===== */}
        <cf-card>
          <cf-hstack gap="3" align="center" wrap>
            <cf-label>You are</cf-label>
            <cf-select
              $value={myName}
              items={identityOptions}
              style={{ minWidth: "160px" }}
            />
            {computed(() => {
              const net = myNet;
              if (net === null) {
                return (
                  <cf-text tone="muted">
                    Pick who you are to see your balance.
                  </cf-text>
                );
              }
              return (
                <cf-badge
                  color={net > 0 ? "accent" : net < 0 ? "danger" : "neutral"}
                >
                  {net > 0
                    ? `You are owed ${money(net)}`
                    : net < 0
                    ? `You owe ${money(-net)}`
                    : "You're settled up"}
                </cf-badge>
              );
            })}
          </cf-hstack>
        </cf-card>

        {/* ===== People ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>People</cf-heading>

            {computed(() =>
              people.length === 0
                ? <cf-text tone="muted">Add people to get started.</cf-text>
                : (
                  <cf-hstack gap="2" wrap>
                    {people.map((person) => (
                      <cf-chip
                        label={person.name}
                        removable
                        oncf-remove={() =>
                          boundRemovePerson.send({ id: person.id })}
                      />
                    ))}
                  </cf-hstack>
                )
            )}

            <cf-hstack gap="2" align="center">
              <cf-input
                $value={personDraft}
                placeholder="Add a person…"
                style={{ flex: 1 }}
              />
              <cf-button
                color="primary"
                variant="solid"
                onClick={boundAddPerson}
              >
                Add
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-card>

        {/* ===== Add expense ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Add expense</cf-heading>

            <cf-vstack gap="1">
              <cf-label>Description</cf-label>
              <cf-input $value={descDraft} placeholder="Dinner, taxi, …" />
            </cf-vstack>

            <cf-hstack gap="3" wrap>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Amount</cf-label>
                <cf-input $value={amountDraft} placeholder="0.00" />
              </cf-vstack>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Paid by</cf-label>
                <cf-select $value={paidByDraft} items={payerOptions} />
              </cf-vstack>
            </cf-hstack>

            <cf-vstack gap="1">
              <cf-label>Split between</cf-label>
              <cf-hstack gap="2" wrap>
                {computed(() =>
                  splitChips.map((c) => (
                    <cf-chip
                      label={c.name}
                      interactive
                      onClick={() => boundToggleSplit.send({ id: c.id })}
                      style={{ opacity: c.included ? "1" : "0.4" }}
                    />
                  ))
                )}
              </cf-hstack>
              <cf-text variant="caption" tone="muted">
                Tap to toggle. Everyone is included by default.
              </cf-text>
            </cf-vstack>

            <cf-button
              color="primary"
              variant="solid"
              onClick={boundAddExpense}
            >
              Add expense
            </cf-button>
          </cf-vstack>
        </cf-card>

        {/* ===== Expense list ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-hstack
              align="center"
              style={{ justifyContent: "space-between" }}
            >
              <cf-heading level={4}>Expenses</cf-heading>
              <cf-text style={{ fontWeight: "600" }}>
                Total {computed(() => money(total))}
              </cf-text>
            </cf-hstack>

            {computed(() =>
              expenses.length === 0
                ? <cf-text tone="muted">No expenses yet.</cf-text>
                : expenses.map((expense) => (
                  <cf-hstack
                    gap="3"
                    align="center"
                    style={{
                      justifyContent: "space-between",
                      borderBottom: "1px solid #eee",
                      paddingBottom: "0.5rem",
                    }}
                  >
                    <cf-vstack gap="0" style={{ flex: 1 }}>
                      <span style={{ fontWeight: "600" }}>
                        {expense.description}
                      </span>
                      <cf-text variant="caption" tone="muted">
                        {computed(() => {
                          const names = nameById;
                          const payer = names[expense.paidBy] ?? "?";
                          const n = expense.sharedBy?.length || 0;
                          return `${payer} paid · split ${n} way${
                            n === 1 ? "" : "s"
                          } · ${expense.date}`;
                        })}
                      </cf-text>
                    </cf-vstack>
                    <span style={{ fontWeight: "600" }}>
                      {computed(() => money(expense.amount))}
                    </span>
                    <cf-button
                      variant="ghost"
                      color="danger"
                      onClick={() =>
                        boundRemoveExpense.send({ id: expense.id })}
                    >
                      ×
                    </cf-button>
                  </cf-hstack>
                ))
            )}
          </cf-vstack>
        </cf-card>

        {/* ===== Balances ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Balances</cf-heading>
            {computed(() =>
              balances.length === 0
                ? <cf-text tone="muted">No balances to show.</cf-text>
                : balances.map((b) => (
                  <cf-hstack
                    align="center"
                    style={{
                      justifyContent: "space-between",
                      fontWeight: b.name === me ? "700" : "400",
                    }}
                  >
                    <span>{b.name === me ? `${b.name} (you)` : b.name}</span>
                    <cf-badge
                      color={b.net > 0
                        ? "accent"
                        : b.net < 0
                        ? "danger"
                        : "neutral"}
                    >
                      {b.net > 0
                        ? `is owed ${money(b.net)}`
                        : b.net < 0
                        ? `owes ${money(-b.net)}`
                        : "settled"}
                    </cf-badge>
                  </cf-hstack>
                ))
            )}
          </cf-vstack>
        </cf-card>

        {/* ===== Settle up ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Settle up</cf-heading>
            {computed(() => {
              const plan = settlements;
              if (plan.length === 0) {
                return (
                  <cf-text tone="muted">Everyone is settled up. 🎉</cf-text>
                );
              }
              return plan.map((s) => (
                <cf-hstack gap="2" align="center">
                  <cf-badge color="danger">{s.from}</cf-badge>
                  <span>→</span>
                  <cf-badge color="accent">{s.to}</cf-badge>
                  <span style={{ fontWeight: "600", marginLeft: "auto" }}>
                    {money(s.amount)}
                  </span>
                </cf-hstack>
              ));
            })}
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    ),

    // Per-space ledger + per-user identity (re-exported for cross-piece reads).
    people,
    expenses,
    myName,
    balances,
    settlements,
    total,

    // Mutations exposed as streams for composition.
    addPerson: boundAddPerson,
    removePerson: boundRemovePerson,
    addExpense: boundAddExpense,
    removeExpense: boundRemoveExpense,
  };
});
