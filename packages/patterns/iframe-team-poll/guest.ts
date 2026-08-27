import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
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
let selectedDraft: string | undefined;
let ballotId: string | undefined;
let casting = false;
let hydrating = true;

const style = document.createElement("style");
style.textContent = `
  :root{font-family:ui-rounded,"SF Pro Rounded",system-ui,sans-serif;color:#17203b;background:#e9edff}*{box-sizing:border-box}
  body{margin:0;background:linear-gradient(145deg,#dfe5ff,#f6f3ff 52%,#ffe9d7)}main{min-height:100%;padding:34px;max-width:900px;margin:auto}
  .eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:850;color:#5c68a2}h1{font-size:clamp(30px,5vw,52px);line-height:1.02;margin:10px 0 24px}
  .grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.panel{background:rgba(255,255,255,.8);backdrop-filter:blur(12px);border:1px solid #fff;border-radius:24px;padding:20px;box-shadow:0 18px 48px rgba(61,69,121,.12)}
  label.option{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:13px;border:1px solid #d9def8;border-radius:14px;margin:10px 0;background:#fff;cursor:pointer}.bar{height:8px;background:#e8eafb;border-radius:9px;overflow:hidden;margin-top:7px}.bar span{display:block;height:100%;background:#6253d9}
  button{width:100%;font:inherit;border:1px solid #c9cdec;border-radius:12px;padding:11px 13px;cursor:pointer;background:#2f277b;color:#fff;font-weight:800;margin-top:12px}.saved{margin-top:14px;color:#5e6692;font-size:13px}.vote{padding:10px 0;border-bottom:1px solid #e4e4f2}.error{color:#a52222;margin-top:16px}
  @media(max-width:680px){main{padding:22px}.grid{grid-template-columns:1fr}}
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

async function castVote(optionId: string): Promise<void> {
  if (!ballotId) {
    throw new Error("The per-user ballot identity could not be resolved.");
  }

  const ballot = state.key("ballots").key(ballotId);
  await ballot.set(optionId);
  await state.pull();
}

function currentVotes(poll: IframeStateData) {
  return Object.entries(poll.ballots ?? {}).map(([id, optionId]) => ({
    id,
    optionId,
  }));
}

function render(): void {
  const config = input.get() ?? DEFAULT_INPUT;
  const poll = state.get() ?? DEFAULT_STATE;
  const votes = currentVotes(poll);
  const canonicalOptionId = ballotId === undefined
    ? undefined
    : poll.ballots?.[ballotId];
  const savedOptionId =
    config.options.some((option) => option.id === canonicalOptionId)
      ? canonicalOptionId
      : null;
  const main = document.createElement("main");
  main.innerHTML = '<div class="eyebrow">Shared tally · PerUser ballot</div>';
  const heading = document.createElement("h1");
  heading.textContent = config.question;
  main.append(heading);
  const grid = document.createElement("div");
  grid.className = "grid";

  const controls = document.createElement("section");
  controls.className = "panel";
  controls.dataset.testid = "ballot";
  const total = Math.max(1, votes.length);
  if (
    selectedDraft !== undefined &&
    !config.options.some((option) => option.id === selectedDraft)
  ) {
    selectedDraft = undefined;
  }
  const selectedOption = selectedDraft ?? savedOptionId;
  for (const option of config.options) {
    const label = document.createElement("label");
    label.className = "option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "option";
    radio.value = option.id;
    radio.checked = selectedOption === option.id;
    radio.disabled = casting;
    radio.addEventListener("change", () => selectedDraft = radio.value);
    const copy = document.createElement("div");
    const count = votes.filter((vote) => vote.optionId === option.id).length;
    copy.innerHTML = `<strong></strong><div class="bar"><span></span></div>`;
    copy.querySelector("strong")!.textContent = option.label;
    (copy.querySelector("span") as HTMLElement).style.width = `${
      count / total * 100
    }%`;
    const tally = document.createElement("strong");
    tally.textContent = String(count);
    label.append(radio, copy, tally);
    controls.append(label);
  }
  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "Cast a pulse";
  submit.disabled = hydrating || casting || config.options.length === 0;
  controls.append(submit);
  const saved = document.createElement("div");
  saved.className = "saved";
  saved.dataset.testid = "saved-ballot";
  saved.dataset.voteId = ballotId ?? "";
  saved.textContent = savedOptionId
    ? `This user last chose ${
      config.options.find((option) => option.id === savedOptionId)?.label ??
        savedOptionId
    }.`
    : "You have not voted yet.";
  controls.append(saved);
  submit.addEventListener("click", () => {
    const selected = controls.querySelector<HTMLInputElement>(
      'input[name="option"]:checked',
    )?.value;
    if (!selected || casting) return;
    casting = true;
    selectedDraft = undefined;
    render();
    run(
      castVote(selected),
      undefined,
      () => casting = false,
    );
  });

  const feed = document.createElement("section");
  feed.className = "panel";
  const feedTitle = document.createElement("h2");
  feedTitle.textContent = `${votes.length} pulses`;
  feed.append(feedTitle);
  for (const vote of votes.slice(-8).reverse()) {
    const item = document.createElement("div");
    item.className = "vote";
    const option = config.options.find((candidate) =>
      candidate.id === vote.optionId
    );
    item.textContent = `Anonymous pulse · ${option?.label ?? vote.optionId}`;
    feed.append(item);
  }
  if (votes.length === 0) {
    feed.append("The room is quiet. Be the first pulse.");
  }
  grid.append(controls, feed);
  main.append(grid);
  if (problem) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = problem;
    main.append(error);
  }
  root.replaceChildren(main);
}

const stops = [input.sink(render), state.sink(render)];
run(
  (async () => {
    const [, , stableBallot] = await Promise.all([
      input.pull(),
      state.pull(),
      output.resolve(),
    ]);
    ballotId = stableBallot.identity?.instanceId;
    if (!ballotId) {
      throw new Error("The per-user ballot identity could not be resolved.");
    }
    if (state.get()?.ballots === undefined) {
      await state.update((current) => ({
        ...(current ?? DEFAULT_STATE),
        ballots: current?.ballots ?? {},
      }));
    }
  })(),
  undefined,
  () => hydrating = false,
);
globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
