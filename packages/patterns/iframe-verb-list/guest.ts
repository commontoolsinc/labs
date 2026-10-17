/**
 * The verb list guest. It shows the pattern's items, which reach it as input,
 * and adds one only by sending the pattern's `addItem` verb an event: the list
 * is the pattern's, so the guest asks for an item rather than writing it.
 * Which items are checked off is the guest's own, kept in `state`.
 */

import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

import {
  type AddItemEvent,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
  type ListItem,
} from "./contract.ts";

const fabric = connectFabric();
const input = fabric.cell<IframeInputData>("input");
const state = fabric.cell<IframeStateData>("state");
const output = fabric.cell<IframeOutputData>("output");
const addItem = fabric.stream<AddItemEvent>("addItem");

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML = `
  <main class="app cf-stack">
    <h1>Verb list</h1>
    <p class="cf-muted" id="status" aria-live="polite">Loading…</p>
    <div class="add cf-row" id="add-row" aria-busy="false">
      <label class="visually-hidden" for="new-item">New item</label>
      <input id="new-item" placeholder="Add an item" autocomplete="off" disabled>
      <button type="button" class="cf-primary" id="add" disabled>Add</button>
    </div>
    <p id="error" role="alert"></p>
    <ul id="items"></ul>
  </main>
`;
const status = root.querySelector<HTMLParagraphElement>("#status")!;
const field = root.querySelector<HTMLInputElement>("#new-item")!;
const addRow = root.querySelector<HTMLDivElement>("#add-row")!;
const add = root.querySelector<HTMLButtonElement>("#add")!;
const error = root.querySelector<HTMLParagraphElement>("#error")!;
const list = root.querySelector<HTMLUListElement>("#items")!;

/** The row drawn for each item, by item id. */
const rows = new Map<string, HTMLLIElement>();

/** Set once every resource an action reads has answered its first pull. */
let hydrated = false;

/** Whether an `addItem` event is on its way to the pattern. */
let sending = false;

function showError(cause: unknown): void {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
}

function rowFor(item: ListItem): HTMLLIElement {
  let row = rows.get(item.id);
  if (!row) {
    row = document.createElement("li");
    row.dataset.itemId = item.id;
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => setChecked(item.id, box.checked));
    label.append(box, document.createElement("span"));
    row.append(label);
    rows.set(item.id, row);
  }
  return row;
}

function render(): void {
  const items = input.get()?.items ?? [];
  const checked = state.get()?.checked ?? {};
  const present = new Set(items.map((item) => item.id));
  for (const [id, row] of rows) {
    if (!present.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  items.forEach((item, index) => {
    const row = rowFor(item);
    const box = row.querySelector("input")!;
    box.checked = checked[item.id] === true;
    box.disabled = !hydrated;
    row.toggleAttribute("data-checked", box.checked);
    row.querySelector("span")!.textContent = item.text;
    if (list.children[index] !== row) {
      list.insertBefore(row, list.children[index] ?? null);
    }
  });

  field.disabled = !hydrated;
  addRow.setAttribute("aria-busy", String(sending));
  add.disabled = !hydrated || sending || field.value.trim() === "";
  const done = items.filter((item) => checked[item.id] === true).length;
  status.textContent = !hydrated
    ? "Loading…"
    : items.length === 0
    ? "Nothing on the list yet."
    : `${items.length} ${
      items.length === 1 ? "item" : "items"
    }, ${done} checked off.`;
}

async function submit(): Promise<void> {
  const text = field.value.trim();
  if (!hydrated || sending || text === "") return;
  sending = true;
  error.textContent = "";
  render();
  try {
    // A fresh id for each item asked for, so the pattern can tell a second
    // item with the same text from this one sent again.
    await addItem.send({ id: crypto.randomUUID(), text });
    // A draft typed while the event was on its way is kept.
    if (field.value.trim() === text) field.value = "";
  } catch (cause) {
    showError(cause);
  } finally {
    sending = false;
    render();
    field.focus();
  }
}

async function setChecked(id: string, value: boolean): Promise<void> {
  try {
    await state.key("checked").key(id).set(value);
    const [{ items }, { checked }] = await Promise.all([
      input.pull(),
      state.pull(),
    ]);
    await output.key("checkedCount").set(
      items.filter((item) => checked[item.id] === true).length,
    );
  } catch (cause) {
    showError(cause);
  }
}

field.addEventListener("input", render);
field.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void submit();
});
add.addEventListener("click", () => void submit());

const stops = [input.sink(render), state.sink(render)];
void (async () => {
  try {
    await Promise.all([input.pull(), state.pull(), output.pull()]);
    await state.initialize(DEFAULT_STATE);
    await output.initialize(DEFAULT_OUTPUT);
    hydrated = true;
    render();
  } catch (cause) {
    showError(cause);
  }
})();

globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
