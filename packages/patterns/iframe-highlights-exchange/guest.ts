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
let noteDraft = "";
let saving = false;
const publishingNotes = new Set<string>();

const style = document.createElement("style");
style.textContent = `
  :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#29241f;background:#fbf7ee}*{box-sizing:border-box}body{margin:0;background:linear-gradient(90deg,#f4e6cc 1px,transparent 1px),linear-gradient(#f4e6cc 1px,transparent 1px),#fbf7ee;background-size:28px 28px}
  main{min-height:100%;padding:32px;max-width:1000px;margin:auto}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:11px;font-weight:850;color:#8b6743}h1{font-family:Georgia,serif;font-size:clamp(34px,5vw,56px);margin:8px 0 6px}.intro{margin:0 0 24px;color:#765f4b}
  .layout{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{background:#fffdf8;border:1px solid #decfb9;border-radius:6px;padding:20px;box-shadow:7px 7px 0 #ead6b8}.panel.shared{background:#fff2c7}.panel h2{margin-top:0}
  textarea,button{font:inherit;width:100%;border:1px solid #cdbb9f;border-radius:5px;padding:11px;background:#fff}textarea{min-height:90px;resize:vertical;margin-top:9px}button{cursor:pointer;background:#6b3e22;color:#fff;font-weight:800;border-color:#6b3e22;margin-top:9px}.note,.highlight{border-top:1px dashed #ccb999;padding:13px 0}.note:first-of-type,.highlight:first-of-type{border-top:0}.by{font-size:12px;color:#856d55;margin-bottom:4px}.empty{color:#907b67;font-style:italic}.error{color:#a12424;margin-top:20px}
  @media(max-width:700px){main{padding:22px}.layout{grid-template-columns:1fr}}
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

async function savePrivateNote(text: string): Promise<void> {
  const current = await state.pull();
  if (current === undefined) await state.set(DEFAULT_STATE);
  await state.key("notes").push({ id: crypto.randomUUID(), text });
}

function render(): void {
  const config = input.get() ?? DEFAULT_INPUT;
  const notebook = state.get() ?? DEFAULT_STATE;
  const exchange = output.get() ?? DEFAULT_OUTPUT;
  const main = document.createElement("main");
  main.innerHTML =
    '<div class="eyebrow">PerUser notebook · PerSpace highlights</div><h1>Highlights exchange</h1>';
  const intro = document.createElement("p");
  intro.className = "intro";
  intro.textContent = config.prompt;
  main.append(intro);
  const layout = document.createElement("div");
  layout.className = "layout";

  const privatePanel = document.createElement("section");
  privatePanel.className = "panel";
  const privateTitle = document.createElement("h2");
  privateTitle.textContent = "My private notebook";
  privatePanel.append(privateTitle);
  const controls = document.createElement("div");
  const noteText = document.createElement("textarea");
  noteText.placeholder = "A thought only you can see until you publish it";
  noteText.value = noteDraft;
  noteText.disabled = saving;
  noteText.addEventListener("input", () => noteDraft = noteText.value);
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Save privately";
  add.disabled = saving;
  controls.append(noteText, add);
  add.addEventListener("click", () => {
    const text = noteText.value.trim();
    if (!text || saving) return;
    saving = true;
    render();
    run(
      savePrivateNote(text),
      () => {
        if (noteDraft.trim() === text) noteDraft = "";
      },
      () => saving = false,
    );
  });
  privatePanel.append(controls);
  if (notebook.notes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No private notes yet.";
    privatePanel.append(empty);
  }
  for (const note of notebook.notes) {
    const item = document.createElement("div");
    item.className = "note";
    item.dataset.noteId = note.id;
    const text = document.createElement("div");
    text.textContent = note.text;
    const publish = document.createElement("button");
    publish.type = "button";
    publish.textContent = "Publish to the room";
    publish.disabled = publishingNotes.has(note.id);
    publish.addEventListener("click", () => {
      if (publishingNotes.has(note.id)) return;
      publishingNotes.add(note.id);
      render();
      run(
        output.key("highlights").push({
          id: crypto.randomUUID(),
          text: note.text,
        }),
        undefined,
        () => publishingNotes.delete(note.id),
      );
    });
    item.append(text, publish);
    privatePanel.append(item);
  }

  const sharedPanel = document.createElement("section");
  sharedPanel.className = "panel shared";
  const sharedTitle = document.createElement("h2");
  sharedTitle.textContent = "Published for everyone";
  sharedPanel.append(sharedTitle);
  if (exchange.highlights.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing has been published.";
    sharedPanel.append(empty);
  }
  for (const highlight of exchange.highlights.slice().reverse()) {
    const item = document.createElement("div");
    item.className = "highlight";
    item.dataset.highlightId = highlight.id;
    const by = document.createElement("div");
    by.className = "by";
    by.textContent = "Shared highlight";
    const text = document.createElement("div");
    text.textContent = highlight.text;
    item.append(by, text);
    sharedPanel.append(item);
  }
  layout.append(privatePanel, sharedPanel);
  main.append(layout);
  if (problem) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = problem;
    main.append(error);
  }
  root.replaceChildren(main);
}

const stops = [input.sink(render), state.sink(render), output.sink(render)];
run(Promise.all([input.pull(), state.pull(), output.pull()]));
globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
