import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

interface LedgerRow {
  id: number;
  memo: string;
  amount: number;
  category: string;
}

const fabric = connectFabric();
const input = fabric.cell<IframeInputData>("input");
const state = fabric.cell<IframeStateData>("state");
const output = fabric.cell<IframeOutputData>("output");
const database = fabric.sqlite("ledgerDatabase");
const root = document.querySelector<HTMLDivElement>("#root")!;
let rows: LedgerRow[] = [];
let loading = true;
let mutationProblem = "";
let queryProblem = "";
let queryGeneration = 0;
let memoDraft = "";
let amountDraft = "";
let categoryDraft = "";
let filterHydrated = false;
let filterDraft = DEFAULT_STATE.categoryFilter;
let pendingFilter: string | null | undefined;
let committing = false;
let hydrated = false;
const SUPERSEDED_QUERY = Symbol("superseded-query");

const style = document.createElement("style");
style.textContent = `
  :root{font-family:"Arial Narrow",ui-sans-serif,system-ui,sans-serif;color:#172127;background:#eaf0ec}*{box-sizing:border-box}body{margin:0;background:linear-gradient(115deg,#dfe8df,#f6f3e9)}
  main{min-height:100%;padding:30px;max-width:1080px;margin:auto}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:900;color:#4d6c5b}h1{font-size:clamp(36px,5vw,62px);line-height:.95;margin:9px 0 24px;text-transform:uppercase;letter-spacing:-.04em}
  .layout{display:grid;grid-template-columns:320px 1fr;gap:18px}.panel{background:#fdfcf6;border:1px solid #bac8bd;border-radius:3px;padding:19px;box-shadow:6px 6px 0 #5c7968}.panel h2{margin:0 0 14px;text-transform:uppercase;font-size:16px;letter-spacing:.04em}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:#5d6d64;margin:12px 0 5px}input,select,button{font:inherit;width:100%;border:1px solid #aebbb1;border-radius:2px;padding:10px;background:#fff}button{cursor:pointer;background:#173e32;color:#fff;border-color:#173e32;font-weight:850;margin-top:13px}
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}.toolbar select{width:auto;min-width:150px}.rows{border-top:2px solid #263d32}.row{display:grid;grid-template-columns:72px 1fr 100px;gap:12px;padding:13px 7px;border-bottom:1px solid #ccd4cc;cursor:pointer}.row:hover,.row.selected{background:#e4eddf}.amount{text-align:right;font-variant-numeric:tabular-nums;font-weight:850}.meta{font-size:11px;color:#64756b;margin-top:3px;text-transform:uppercase}.empty{padding:28px 6px;color:#68786e}.scope{font-size:12px;color:#6b796f;margin-top:16px}.error{color:#9f2626;margin-top:16px}
  @media(max-width:760px){main{padding:20px}.layout{grid-template-columns:1fr}.row{grid-template-columns:55px 1fr 80px}}
`;
document.head.append(style);

function runMutation(
  operation: Promise<unknown>,
  onSuccess: () => void = () => {},
  onSettled: () => void = () => {},
): void {
  void operation.then(
    () => {
      onSuccess();
      onSettled();
      mutationProblem = "";
      render();
    },
    (error) => {
      onSettled();
      mutationProblem = error instanceof Error ? error.message : String(error);
      render();
    },
  );
}

function runRefresh(operation: Promise<unknown>): void {
  void operation.then(
    () => {
      queryProblem = "";
      render();
    },
    (error) => {
      if (error !== SUPERSEDED_QUERY) {
        queryProblem = error instanceof Error ? error.message : String(error);
        loading = false;
      }
      render();
    },
  );
}

async function refreshRows(): Promise<void> {
  if (!hydrated) return;
  const generation = ++queryGeneration;
  loading = true;
  render();
  const preference = state.get() ?? DEFAULT_STATE;
  const config = input.get() ?? DEFAULT_INPUT;
  const requestedFilter = pendingFilter === undefined
    ? preference.categoryFilter
    : pendingFilter;
  const categoryFilter = requestedFilter === null ||
      config.categories.includes(requestedFilter)
    ? requestedFilter
    : null;
  if (
    pendingFilter === undefined &&
    categoryFilter !== preference.categoryFilter
  ) {
    filterDraft = categoryFilter;
    filterHydrated = true;
    await state.set({ ...preference, categoryFilter });
    if (generation !== queryGeneration) throw SUPERSEDED_QUERY;
  }
  let result: { rows: LedgerRow[] };
  try {
    result = categoryFilter === null
      ? await database.query<LedgerRow>(
        "SELECT id, memo, amount, category FROM entries ORDER BY id DESC",
      )
      : await database.query<LedgerRow>(
        "SELECT id, memo, amount, category FROM entries WHERE category = ? ORDER BY id DESC",
        [categoryFilter],
      );
  } catch (error) {
    if (generation !== queryGeneration) throw SUPERSEDED_QUERY;
    throw error;
  }
  if (generation !== queryGeneration) throw SUPERSEDED_QUERY;
  rows = result.rows;
  loading = false;
  render();
}

function adoptStoredFilter(): void {
  if (pendingFilter !== undefined) return;
  const stored = state.get();
  if (!stored) return;
  filterDraft = stored.categoryFilter;
  filterHydrated = true;
}

function refreshPreference(): void {
  if (!hydrated) {
    render();
    return;
  }
  adoptStoredFilter();
  runRefresh(refreshRows());
}

function refreshSource(): void {
  if (!hydrated) {
    render();
    return;
  }
  runRefresh(refreshRows());
}

async function hydrateLedger(): Promise<void> {
  await Promise.all([input.pull(), state.pull(), output.pull()]);
  hydrated = true;
  adoptStoredFilter();
  await refreshRows();
}

function render(): void {
  const config = input.get() ?? DEFAULT_INPUT;
  const storedPreference = state.get();
  const preference = storedPreference ?? DEFAULT_STATE;
  if (!filterHydrated && storedPreference) {
    filterDraft = storedPreference.categoryFilter;
    filterHydrated = true;
  }
  if (filterDraft !== null && !config.categories.includes(filterDraft)) {
    filterDraft = null;
  }
  if (!config.categories.includes(categoryDraft)) {
    categoryDraft = config.categories[0] ?? "";
  }
  const session = output.get() ?? DEFAULT_OUTPUT;
  const main = document.createElement("main");
  main.innerHTML =
    '<div class="eyebrow">PerSpace SQLite · PerUser filters · PerSession selection</div>';
  const heading = document.createElement("h1");
  heading.textContent = config.title;
  main.append(heading);
  const layout = document.createElement("div");
  layout.className = "layout";

  const controls = document.createElement("section");
  controls.className = "panel";
  controls.dataset.testid = "ledger-entry";
  const formTitle = document.createElement("h2");
  formTitle.textContent = "Post an entry";
  const memoLabel = document.createElement("label");
  memoLabel.textContent = "Memo";
  const memo = document.createElement("input");
  memo.placeholder = "Train to the field site";
  memo.required = true;
  memo.value = memoDraft;
  memo.disabled = !hydrated || committing;
  memo.addEventListener("input", () => memoDraft = memo.value);
  const amountLabel = document.createElement("label");
  amountLabel.textContent = "Amount";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.step = "0.01";
  amount.min = "0";
  amount.required = true;
  amount.value = amountDraft;
  amount.disabled = !hydrated || committing;
  amount.addEventListener("input", () => amountDraft = amount.value);
  const categoryLabel = document.createElement("label");
  categoryLabel.textContent = "Category";
  const category = document.createElement("select");
  for (const item of config.categories) {
    category.add(new Option(item, item, false, item === categoryDraft));
  }
  category.disabled = !hydrated || committing || config.categories.length === 0;
  category.addEventListener("change", () => categoryDraft = category.value);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "Commit to shared SQLite";
  submit.disabled = !hydrated || committing || config.categories.length === 0;
  const scope = document.createElement("div");
  scope.className = "scope";
  scope.textContent =
    "Rows are shared. Filters follow the user; row selection belongs only to this session.";
  controls.append(
    formTitle,
    memoLabel,
    memo,
    amountLabel,
    amount,
    categoryLabel,
    category,
    submit,
    scope,
  );
  submit.addEventListener("click", () => {
    const memoValue = memo.value.trim();
    const amountValue = Number(amount.value);
    if (!hydrated || committing) return;
    if (!memoValue) {
      memo.reportValidity();
      return;
    }
    if (
      !amount.value || !amount.validity.valid || !Number.isFinite(amountValue)
    ) {
      amount.reportValidity();
      return;
    }
    committing = true;
    memoDraft = memo.value;
    amountDraft = amount.value;
    categoryDraft = category.value;
    render();
    runMutation(
      database.exec(
        "INSERT INTO entries (memo, amount, category) VALUES (?, ?, ?)",
        [memoValue, amountValue, category.value],
      ),
      () => {
        if (memoDraft.trim() === memoValue) memoDraft = "";
        if (Number(amountDraft) === amountValue) amountDraft = "";
        runMutation(output.update((current) => ({
          ...(current ?? DEFAULT_OUTPUT),
          selectedEntryId: null,
          lastInsertedMemo: memoValue,
        })));
        runRefresh(refreshRows());
      },
      () => committing = false,
    );
  });

  const list = document.createElement("section");
  list.className = "panel";
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  const listTitle = document.createElement("h2");
  listTitle.textContent = loading
    ? "Loading ledger…"
    : `${rows.length} entries`;
  const filter = document.createElement("select");
  filter.dataset.testid = "category-filter";
  filter.disabled = !hydrated || pendingFilter !== undefined;
  filter.add(new Option("All categories", "all"));
  for (const [index, item] of config.categories.entries()) {
    filter.add(
      new Option(item, `category:${index}`, false, item === filterDraft),
    );
  }
  const filterIndex = filterDraft === null
    ? -1
    : config.categories.indexOf(filterDraft);
  filter.value = filterIndex < 0 ? "all" : `category:${filterIndex}`;
  filter.addEventListener("change", () => {
    if (!hydrated || pendingFilter !== undefined) return;
    const requested = filter.value === "all"
      ? null
      : config.categories[Number(filter.value.slice("category:".length))] ??
        null;
    filterDraft = requested;
    filterHydrated = true;
    pendingFilter = requested;
    const operation = state.set({
      ...preference,
      categoryFilter: requested,
    });
    render();
    runMutation(
      operation,
      () => {},
      () => {
        pendingFilter = undefined;
        adoptStoredFilter();
        runRefresh(refreshRows());
      },
    );
  });
  toolbar.append(listTitle, filter);
  list.append(toolbar);
  const rowList = document.createElement("div");
  rowList.className = "rows";
  if (!loading && rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No matching entries yet.";
    rowList.append(empty);
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = `row${
      session.selectedEntryId === row.id ? " selected" : ""
    }`;
    item.dataset.entryId = String(row.id);
    const id = document.createElement("strong");
    id.textContent = `#${row.id}`;
    const copy = document.createElement("div");
    const memoText = document.createElement("div");
    memoText.textContent = row.memo;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = row.category;
    copy.append(memoText, meta);
    const amountText = document.createElement("div");
    amountText.className = "amount";
    amountText.textContent = row.amount.toFixed(2);
    item.append(id, copy, amountText);
    item.addEventListener(
      "click",
      () =>
        runMutation(output.update((current) => ({
          ...(current ?? DEFAULT_OUTPUT),
          selectedEntryId: row.id,
        }))),
    );
    rowList.append(item);
  }
  list.append(rowList);
  layout.append(controls, list);
  main.append(layout);
  const problem = mutationProblem || queryProblem;
  if (problem) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = problem;
    main.append(error);
  }
  root.replaceChildren(main);
}

const stops = [
  input.sink(refreshSource),
  state.sink(refreshPreference),
  output.sink(render),
  database.sink(refreshSource),
];
runRefresh(hydrateLedger());
globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
