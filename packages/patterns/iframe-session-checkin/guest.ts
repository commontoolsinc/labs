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
let draftHydrated = false;
let moodDraft = DEFAULT_STATE.mood;
let messageDraft = DEFAULT_STATE.message;
let submitting = false;

const style = document.createElement("style");
style.textContent = `
  :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#f3f4ff;background:#101426}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% 15%,#39417c 0,transparent 33%),radial-gradient(circle at 12% 78%,#153d43 0,transparent 36%),#101426}
  main{min-height:100%;padding:34px;max-width:980px;margin:auto}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:850;color:#aab4ef}h1{font-size:clamp(34px,5vw,58px);line-height:1;margin:9px 0 24px;max-width:760px}
  .layout{display:grid;grid-template-columns:.85fr 1.15fr;gap:18px}.panel{background:rgba(20,25,47,.82);border:1px solid #4b527b;border-radius:22px;padding:20px;box-shadow:0 20px 55px rgba(0,0,0,.24)}label{display:block;font-size:12px;color:#bcc3ed;margin:13px 0 6px}
  textarea,select,button{font:inherit;width:100%;border:1px solid #565f8b;border-radius:12px;padding:11px 13px;background:#181e38;color:#fff}textarea{min-height:110px;resize:vertical}button{cursor:pointer;background:#b9f46d;color:#172015;border-color:#b9f46d;font-weight:850;margin-top:15px}
  .submission{padding:13px 0;border-bottom:1px solid #3e456d}.submission:last-child{border-bottom:0}.meta{color:#b9f46d;font-size:12px;font-weight:800;margin-bottom:5px}.empty{color:#929bc9}.scope{font-size:12px;color:#929bc9;margin-top:12px}.error{color:#ff9999;margin-top:16px}
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

async function submitCheckin(
  current: Pick<IframeStateData, "mood" | "message">,
): Promise<void> {
  const stored = await state.pull() ?? DEFAULT_STATE;
  const pendingSubmissionId = stored.pendingSubmissionId !== null &&
      stored.pendingSubmissionId !== undefined &&
      stored.mood === current.mood && stored.message === current.message
    ? stored.pendingSubmissionId
    : crypto.randomUUID();
  const pending = { ...current, pendingSubmissionId };
  await state.set(pending);

  const room = await output.pull() ?? DEFAULT_OUTPUT;
  if (!room.submissions.some(({ id }) => id === pendingSubmissionId)) {
    await output.key("submissions").push({
      id: pendingSubmissionId,
      ...current,
    });
  }
  await state.set({ ...pending, message: "", pendingSubmissionId: null });
}

async function hydrateDrafts(): Promise<void> {
  const [, stored] = await Promise.all([
    input.pull(),
    state.pull(),
    output.pull(),
  ]);
  if (!draftHydrated) {
    const draft = stored ?? DEFAULT_STATE;
    moodDraft = draft.mood;
    messageDraft = draft.message;
    draftHydrated = true;
  }
}

function render(): void {
  const config = input.get() ?? DEFAULT_INPUT;
  const room = output.get() ?? DEFAULT_OUTPUT;
  const main = document.createElement("main");
  main.innerHTML =
    '<div class="eyebrow">PerSession draft · PerSpace submitted feed</div>';
  const heading = document.createElement("h1");
  heading.textContent = config.question;
  main.append(heading);
  const layout = document.createElement("div");
  layout.className = "layout";

  const controls = document.createElement("section");
  controls.className = "panel";
  controls.dataset.testid = "checkin";
  const moodLabel = document.createElement("label");
  moodLabel.textContent = "Current mode";
  const mood = document.createElement("select");
  if (!config.moods.includes(moodDraft)) {
    moodDraft = config.moods[0] ?? "";
  }
  for (const item of config.moods) {
    mood.add(new Option(item, item, false, item === moodDraft));
  }
  mood.disabled = !draftHydrated || submitting || config.moods.length === 0;
  const messageLabel = document.createElement("label");
  messageLabel.textContent = "What should the room know?";
  const message = document.createElement("textarea");
  message.value = messageDraft;
  message.required = true;
  message.disabled = !draftHydrated || submitting;
  const persist = () => {
    const stored = state.get() ?? DEFAULT_STATE;
    return state.set({
      ...stored,
      mood: moodDraft,
      message: messageDraft,
    });
  };
  mood.addEventListener("change", () => {
    moodDraft = mood.value;
    run(persist());
  });
  message.addEventListener("input", () => {
    messageDraft = message.value;
  });
  message.addEventListener("change", () => run(persist()));
  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "Share this check-in";
  submit.disabled = !draftHydrated || submitting || config.moods.length === 0;
  const scope = document.createElement("div");
  scope.className = "scope";
  scope.textContent =
    "A different tab starts with its own draft, even for the same user.";
  controls.append(
    moodLabel,
    mood,
    messageLabel,
    message,
    submit,
    scope,
  );
  submit.addEventListener("click", () => {
    const current = {
      mood: mood.value,
      message: message.value.trim(),
    };
    if (!draftHydrated || !current.message || submitting) return;
    submitting = true;
    moodDraft = current.mood;
    messageDraft = current.message;
    render();
    run(
      submitCheckin(current),
      () => messageDraft = "",
      () => submitting = false,
    );
  });

  const feed = document.createElement("section");
  feed.className = "panel";
  const feedTitle = document.createElement("h2");
  feedTitle.textContent = "Room check-ins";
  feed.append(feedTitle);
  if (room.submissions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nobody has checked in yet.";
    feed.append(empty);
  }
  for (const submission of room.submissions.slice().reverse()) {
    const item = document.createElement("div");
    item.className = "submission";
    item.dataset.submissionId = submission.id;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = submission.mood;
    const copy = document.createElement("div");
    copy.textContent = submission.message;
    item.append(meta, copy);
    feed.append(item);
  }
  layout.append(controls, feed);
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
run(hydrateDrafts());
globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
