/**
 * Fair Share — a shared expense ledger.
 *
 * Track who paid for what in a group, split each expense among the people who
 * shared it, and see net balances plus a minimal "settle up" plan of who should
 * pay whom. Inspired by group expense-splitting apps.
 */
import {
  computed,
  Default,
  NAME,
  nonPrivateRandom,
  pattern,
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
  from: string; // debtor name
  to: string; // creditor name
  amount: number;
}

interface State {
  people: Writable<Person[] | Default<[]>>;
  expenses: Writable<Expense[] | Default<[]>>;
}

// ============ HELPERS ============

const newId = (prefix: string): string =>
  `${prefix}_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

const getTodayDate = (): string => new Date().toISOString().split("T")[0];

const money = (n: number): string => `$${(n || 0).toFixed(2)}`;

// Tolerance for floating-point cents when settling.
const EPS = 0.005;

const computeSettlements = (balances: Balance[]): Settlement[] => {
  const creditors = balances
    .filter((b) => b.net > EPS)
    .map((b) => ({ name: b.name, rem: b.net }))
    .sort((a, b) => b.rem - a.rem);
  const debtors = balances
    .filter((b) => b.net < -EPS)
    .map((b) => ({ name: b.name, rem: -b.net }))
    .sort((a, b) => b.rem - a.rem);

  const result: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amount = Math.min(d.rem, c.rem);
    if (amount > EPS) {
      result.push({ from: d.name, to: c.name, amount });
    }
    d.rem -= amount;
    c.rem -= amount;
    if (d.rem <= EPS) i++;
    if (c.rem <= EPS) j++;
  }
  return result;
};

// ============ PATTERN ============

export default pattern<State>(({ people, expenses }) => {
  // --- Local form state ---
  const newPersonName = new Writable("");
  const newDescription = new Writable("");
  const newAmount = new Writable("");
  const newPaidBy = new Writable(""); // Person.id
  const splitWith = new Writable<string[]>([]); // Person.id[]; empty => everyone

  // --- Derived data ---
  const peopleOptions = computed(() =>
    people.get().map((p) => ({ label: p.name, value: p.id }))
  );

  const total = computed(() =>
    expenses.get().reduce((sum, e) => sum + (e.amount || 0), 0)
  );

  const nameById = computed(() => {
    const map: Record<string, string> = {};
    for (const p of people.get()) map[p.id] = p.name;
    return map;
  });

  const balances = computed<Balance[]>(() => {
    const ppl = people.get();
    const exps = expenses.get();
    const acc = new Map<string, Balance>(
      ppl.map((
        p,
      ) => [p.id, { id: p.id, name: p.name, paid: 0, share: 0, net: 0 }]),
    );

    for (const e of exps) {
      const payer = acc.get(e.paidBy);
      if (payer) payer.paid += e.amount || 0;

      const everyone = ppl.map((p) => p.id);
      const shareIds = (e.sharedBy && e.sharedBy.length ? e.sharedBy : everyone)
        .filter((id) => acc.has(id));
      if (shareIds.length === 0) continue;

      const per = (e.amount || 0) / shareIds.length;
      for (const id of shareIds) {
        const b = acc.get(id);
        if (b) b.share += per;
      }
    }

    return ppl.map((p) => {
      const b = acc.get(p.id)!;
      return { ...b, net: b.paid - b.share };
    });
  });

  const settlements = computed(() => computeSettlements(balances));

  // --- Display helpers for the "split with" chips in the form ---
  const splitChips = computed(() =>
    people.get().map((p) => ({
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

        {/* ===== People ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>People</cf-heading>

            <cf-hstack gap="2" wrap>
              {people.map((person) => (
                <cf-chip
                  label={person.name}
                  removable
                  oncf-remove={() => {
                    const cur = people.get();
                    const idx = cur.findIndex((el) => el.id === person.id);
                    if (idx >= 0) people.set(cur.toSpliced(idx, 1));
                  }}
                />
              ))}
            </cf-hstack>

            <cf-hstack gap="2" align="center">
              <cf-input
                $value={newPersonName}
                placeholder="Add a person…"
                style={{ flex: 1 }}
              />
              <cf-button
                color="primary"
                variant="solid"
                onClick={() => {
                  const name = newPersonName.get().trim();
                  if (!name) return;
                  if (people.get().some((p) => p.name === name)) return;
                  people.push({ id: newId("p"), name });
                  newPersonName.set("");
                }}
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
              <cf-input $value={newDescription} placeholder="Dinner, taxi, …" />
            </cf-vstack>

            <cf-hstack gap="3" wrap>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Amount</cf-label>
                <cf-input $value={newAmount} placeholder="0.00" />
              </cf-vstack>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Paid by</cf-label>
                <cf-select $value={newPaidBy} items={peopleOptions} />
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
                      onClick={() => {
                        const cur = splitWith.get();
                        // First explicit toggle starts from "everyone".
                        const base = cur.length === 0
                          ? people.get().map((p) => p.id)
                          : cur;
                        splitWith.set(
                          base.includes(c.id)
                            ? base.filter((x) => x !== c.id)
                            : [...base, c.id],
                        );
                      }}
                      style={{
                        opacity: c.included ? "1" : "0.4",
                      }}
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
              onClick={() => {
                const description = newDescription.get().trim();
                const amount = parseFloat(newAmount.get());
                const paidBy = newPaidBy.get();
                if (!description || isNaN(amount) || amount <= 0 || !paidBy) {
                  return;
                }
                const everyone = people.get().map((p) => p.id);
                const selected = splitWith.get();
                const sharedBy: string[] = [
                  ...(selected.length === 0 ? everyone : selected),
                ];
                expenses.push({
                  id: newId("e"),
                  description,
                  amount,
                  paidBy,
                  sharedBy,
                  date: getTodayDate(),
                });
                newDescription.set("");
                newAmount.set("");
                splitWith.set([]);
              }}
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

            {expenses.map((expense) => (
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
                  onClick={() => {
                    const cur = expenses.get();
                    const idx = cur.findIndex((el) => el.id === expense.id);
                    if (idx >= 0) expenses.set(cur.toSpliced(idx, 1));
                  }}
                >
                  ×
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
        </cf-card>

        {/* ===== Balances ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Balances</cf-heading>
            {computed(() =>
              balances.map((b) => (
                <cf-hstack
                  align="center"
                  style={{ justifyContent: "space-between" }}
                >
                  <span>{b.name}</span>
                  <cf-badge
                    color={b.net > EPS
                      ? "accent"
                      : b.net < -EPS
                      ? "danger"
                      : "neutral"}
                  >
                    {b.net > EPS
                      ? `is owed ${money(b.net)}`
                      : b.net < -EPS
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

    people,
    expenses,
    balances,
    settlements,
    total,
  };
});
