import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const fabric = connectFabric();
const input = fabric.cell<IframeInputData>("input");
const state = fabric.cell<IframeStateData>("state");
const output = fabric.cell<IframeOutputData>("output");
const root = document.querySelector<HTMLDivElement>("#root")!;
let problem = "";
let hydrated = false;
let cardTitleDraft = "";
let cardColumnDraft = "";
let adding = false;
const movingCards = new Set<string>();

const style = document.createElement("style");
style.textContent = `
  :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17211b;background:#f4f1e8}
  *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at top left,#fff8d8,transparent 38%),#f4f1e8}
  main{min-height:100%;padding:28px}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:11px;font-weight:800;color:#65746a}
  h1{font-family:Georgia,serif;font-size:clamp(30px,5vw,52px);line-height:.95;margin:8px 0 12px}.sub{color:#65746a;margin:0 0 24px}
  .controls{display:grid;grid-template-columns:minmax(180px,1fr) 150px auto;gap:10px;margin-bottom:22px}input,select,button{font:inherit;border-radius:12px;border:1px solid #c8c9bd;padding:11px 13px;background:#fff}
  button{cursor:pointer;font-weight:750;background:#173f2a;color:#fff;border-color:#173f2a}button.secondary{background:#fff;color:#173f2a}
  .board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.column{min-height:360px;background:rgba(255,255,255,.72);border:1px solid #d8d6c8;border-radius:18px;padding:14px;box-shadow:0 12px 35px rgba(49,55,43,.06)}
  .column h2{font-size:14px;margin:2px 2px 12px}.count{float:right;color:#738077}.card{background:#fff;border:1px solid #deddd3;border-radius:14px;padding:13px;margin:9px 0;box-shadow:0 6px 16px rgba(40,46,38,.06)}
  .card.selected{outline:3px solid #f3b93f}.card-title{font-weight:750;margin-bottom:10px}.actions{display:flex;gap:7px}.actions button{font-size:12px;padding:7px 9px}.empty{color:#869087;font-size:13px;padding:24px 8px}.error{color:#a32424;margin-top:18px}
  @media(max-width:720px){.controls{grid-template-columns:1fr}.board{grid-template-columns:1fr}.column{min-height:160px}}
`;
document.head.append(style);

function run(
  operation: Promise<unknown>,
  onSuccess: () => void = () => {},
  onSettled: () => void = () => {},
): void {
  void operation.then(
    () => {
      onSuccess();
      onSettled();
      problem = "";
      render();
    },
    (error) => {
      onSettled();
      problem = error instanceof Error ? error.message : String(error);
      render();
    },
  );
}

async function hydrateBoard(): Promise<void> {
  await Promise.all([input.pull(), state.pull(), output.pull()]);
  hydrated = true;
}

function render(): void {
  const config = input.get() ?? DEFAULT_INPUT;
  const storedBoard = state.get();
  const board = storedBoard ?? DEFAULT_STATE;
  const preference = output.get() ?? DEFAULT_OUTPUT;
  const main = document.createElement("main");
  main.innerHTML = `
    <div class="eyebrow">PerSpace board · PerUser selection</div>
    <h1></h1><p class="sub">Cards are shared. Your amber selection follows your user across sessions.</p>
  `;
  main.querySelector("h1")!.textContent = config.boardName;

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.dataset.testid = "add-card";
  const title = document.createElement("input");
  title.placeholder = "Add a card";
  title.required = true;
  title.value = cardTitleDraft;
  title.disabled = !hydrated || adding;
  title.addEventListener("input", () => cardTitleDraft = title.value);
  const column = document.createElement("select");
  for (const item of config.columns) {
    column.add(new Option(item.label, item.id));
  }
  if (!config.columns.some((item) => item.id === cardColumnDraft)) {
    cardColumnDraft = config.columns[0]?.id ?? "";
  }
  column.value = cardColumnDraft;
  column.disabled = !hydrated || config.columns.length === 0 || adding;
  column.addEventListener("change", () => cardColumnDraft = column.value);
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add together";
  add.disabled = !hydrated || storedBoard === undefined ||
    config.columns.length === 0 || adding;
  controls.append(title, column, add);
  add.addEventListener("click", () => {
    const value = title.value.trim();
    const destination = column.value;
    if (
      !hydrated || !value || !destination || storedBoard === undefined || adding
    ) return;
    adding = true;
    render();
    run(
      state.key("cards").push({
        id: crypto.randomUUID(),
        title: value,
        column: destination,
      }),
      () => {
        if (cardTitleDraft.trim() === value) cardTitleDraft = "";
      },
      () => adding = false,
    );
  });
  main.append(controls);

  const columns = document.createElement("section");
  columns.className = "board";
  for (const item of config.columns) {
    const section = document.createElement("article");
    section.className = "column";
    section.dataset.column = item.id;
    const cards = board.cards.filter((card) => card.column === item.id);
    const heading = document.createElement("h2");
    heading.textContent = item.label;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(cards.length);
    heading.append(count);
    section.append(heading);
    if (cards.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing here yet";
      section.append(empty);
    }
    for (const card of cards) {
      const cardIndex = board.cards.findIndex((candidate) =>
        candidate.id === card.id
      );
      const element = document.createElement("div");
      element.className = `card${
        preference.selectedCardId === card.id ? " selected" : ""
      }`;
      element.dataset.cardId = card.id;
      const label = document.createElement("div");
      label.className = "card-title";
      label.textContent = card.title;
      const actions = document.createElement("div");
      actions.className = "actions";
      const select = document.createElement("button");
      select.type = "button";
      select.className = "secondary";
      select.textContent = preference.selectedCardId === card.id
        ? "Selected"
        : "Select";
      select.disabled = !hydrated;
      select.addEventListener(
        "click",
        () => {
          if (hydrated) run(output.set({ selectedCardId: card.id }));
        },
      );
      const move = document.createElement("button");
      move.type = "button";
      move.className = "secondary";
      move.textContent = "Move";
      move.disabled = !hydrated || config.columns.length < 2 ||
        movingCards.has(card.id);
      move.addEventListener("click", () => {
        if (
          !hydrated || config.columns.length < 2 || movingCards.has(card.id)
        ) return;
        movingCards.add(card.id);
        render();
        run(
          state.key("cards").key(cardIndex).resolve().then((stableCard) =>
            stableCard.update((currentCard) => {
              const current = config.columns.findIndex((candidate) =>
                candidate.id === currentCard.column
              );
              const next = config.columns[
                current < 0 ? 0 : (current + 1) % config.columns.length
              ];
              return { ...currentCard, column: next.id };
            })
          ),
          undefined,
          () => movingCards.delete(card.id),
        );
      });
      actions.append(select, move);
      element.append(label, actions);
      section.append(element);
    }
    columns.append(section);
  }
  main.append(columns);
  if (problem) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = problem;
    main.append(error);
  }
  root.replaceChildren(main);
}

const stops = [input.sink(render), state.sink(render), output.sink(render)];
run(hydrateBoard());
globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
