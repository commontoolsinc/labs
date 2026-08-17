import { Identity } from "@commonfabric/identity";
import {
  CdpWorkerProfiler,
  env,
  type Page,
  presentationInteractions,
  renderProfileReport,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { isLink, UI } from "@commonfabric/runner";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  CLICK_TARGET_ATTR,
  clickCfButton,
  clickMarked,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  logStepTimings,
  settleView,
  StepTimer,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const AUTHOR = "Ada Lovelace";
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

/**
 * How many topics the scenario composes through the UI. Two is enough to prove
 * the reference graph (one topic mentioning another); a large count is what
 * makes the board's per-card rendering and its cold-load cost visible, and is
 * the interesting case to record.
 */
const TOPIC_COUNT = Number(Deno.env.get("TOPICS_COUNT") ?? "2");

/**
 * How many of those are composed through the UI. The rest are seeded through
 * `addTopic` in `beforeAll`, which is setup and not the scenario: the authoring
 * story needs a couple of real composer round-trips to be a regression test,
 * and a large board needs to exist without the video spending twenty minutes
 * watching a name typed one character at a time (presentation mode animates
 * every keystroke, and each compose re-settles a board that is still growing).
 */
const COMPOSED_COUNT = Math.min(TOPIC_COUNT, 2);
const SEEDED_COUNT = TOPIC_COUNT - COMPOSED_COUNT;

/**
 * When set, the scenario ends by cold-loading the board again, waiting for the
 * whole list to render, opening the topmost topic, and waiting for its detail
 * page — a browser worker reading the board back out of persisted VDOM at
 * whatever `TOPICS_COUNT` was built.
 */
const RELOAD_AT_END = (Deno.env.get("TOPICS_RELOAD") ?? "") !== "";

/**
 * Where the seeded topics are created.
 *
 * Unset, they are created in `beforeAll` — off screen and before the board is
 * ever opened, so a recording starts on a board that already holds them. Set,
 * they are created from the agent-facing verb while the board is on screen and
 * the overlay counts each one, which shows the board filling live (and how the
 * fill paces as the list grows).
 */
const SEED_ON_SCREEN = (Deno.env.get("TOPICS_SEED_ONSCREEN") ?? "") !== "";

/**
 * When set to a directory, every on-screen `addTopic` append writes a snapshot
 * of the board's rendered tree there: the persisted VDOM walked as cells (so
 * every node carries the entity id and path it lives at), the main thread's
 * renderer node-id graph, and a DOM element identity tag per card. Consecutive
 * snapshots are then diffable for "same tree plus one card, modulo ids".
 */
const SNAPSHOT_DIR = Deno.env.get("TOPICS_SNAPSHOT_DIR") ?? "";

/**
 * Which phases to CPU-profile in the browser's runtime worker: a
 * comma-separated list of the phase ids the steps below declare (`seed`,
 * `compose`, `comment`, `reload`, `detail`), or `all` for every one of them.
 *
 * This is the measurement that step wall-clock cannot give: the scheduler's
 * own spans attribute barely a tenth of `scheduler/run/action`, and elapsed
 * time on a loaded machine varies by more than the differences under test. A
 * V8 sampling profile of the worker attributes all of it, by function.
 */
const CPUPROFILE_PHASES = new Set(
  (Deno.env.get("TOPICS_CPUPROFILE") ?? "").split(",")
    .map((phase) => phase.trim()).filter(Boolean),
);

/** Where `.cpuprofile` and report files land. */
const CPUPROFILE_DIR = Deno.env.get("CF_CPUPROFILE_DIR") ?? "/tmp";

/**
 * Sampling period. The default 250µs the profiler ships costs a sample every
 * quarter-millisecond, and these windows are whole minutes rather than the
 * single note-create the profiler was written for — a coarser period keeps the
 * profile inside the CDP websocket message limit and still resolves a 2ms
 * action.
 */
const CPUPROFILE_INTERVAL_US = Number(
  Deno.env.get("TOPICS_CPUPROFILE_INTERVAL_US") ?? "500",
);

// Astral names the runtime worker's script; matching its URL is how the
// profiler picks the worker out of the page's other targets.
const RUNTIME_WORKER_URL = "worker-runtime";

/**
 * How many EXTRA adds to time individually, once the seeded board exists.
 *
 * The seeded adds answer "how long to build a board"; these answer the question
 * that actually matters for a regression — what one more add costs on a board
 * that size, measured twice: with no renderer attached, and with the board on
 * screen. The difference between those two is the rendering cost, and the
 * difference between an early and a late one is how the cost scales.
 */
const MEASURE_ADDS = Number(Deno.env.get("TOPICS_MEASURE") ?? "0");

/** One timed add, reported as a parseable line rather than a step duration. */
async function timedAdd(
  add: () => Promise<void>,
  phase: string,
  index: number,
  boardSize: number,
): Promise<void> {
  const started = performance.now();
  await add();
  console.log(
    "TOPICS_ADD " + JSON.stringify({
      phase,
      index,
      boardSize,
      ms: Math.round(performance.now() - started),
    }),
  );
}

const titleFor = (index: number) => `Topic ${index + 1} of ${TOPIC_COUNT}`;
const FIRST_TITLE = titleFor(0);
const LAST_TITLE = titleFor(TOPIC_COUNT - 1);
const COMMENT_PREFIX = "This depends on";

// The board renders exactly one text field and one button — the footer
// composer. A descendant selector across the shadow boundary
// (`cf-vstack[slot='footer'] cf-button`) does not resolve under `pierce`, and
// the bare tag is unambiguous here. Everything clicked by name below goes
// through `clickButtonWithExactText`, which matches accessible text.
const COMPOSER_BUTTON = "cf-button";
const COMPOSER_INPUT = "cf-input";

/**
 * The authoring half of the Topics browser story, told through the rendered
 * board and detail page: compose topics, comment on one with a sibling's fid
 * pasted into the prose, and watch the reference graph light up on both ends.
 *
 * `topics-navigation.test.ts` owns the other half — that a cold-loaded board
 * navigates through persisted VDOM with no scheduler handlers registered — and
 * seeds its topics through `addTopic` because navigation, not authoring, is
 * what it proves. Nothing here sends an output stream to drive the scenario:
 * every topic, comment, and edge below comes from filling and clicking the same
 * controls a person uses, which is what makes this a regression test for the
 * composer gating, the card list, and the reference cards rather than for the
 * pattern's data layer (covered by `packages/patterns/topics/topics.test.tsx`).
 *
 * Environment knobs: `TOPICS_COUNT` (default 2) and `TOPICS_RELOAD` (unset).
 */
describe("Topics browser authoring", () => {
  const shell = new ShellIntegration({
    presentation: { label: "Topics", color: "#31572c" },
  });
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let board: PieceController;
  let boardSinkCancel: (() => void) | undefined;
  let uiSinkCancel: (() => void) | undefined;
  let uiCell: any;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    // Pre-create the space-root pattern so the browser RESUMEs it instead of
    // cold-compiling default-app inside its worker (see lunch-poll-vote).
    await cc.ensureDefaultPattern();

    const sourcePath = join(import.meta.dirname!, "..", "topics", "main.tsx");
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    board = await cc.create(program, { start: true });

    const resultCell = cc.getResult(board.getCell());
    boardSinkCancel = resultCell.sink(() => {});

    if (SNAPSHOT_DIR !== "") {
      await Deno.mkdir(SNAPSHOT_DIR, { recursive: true });
      uiCell = (resultCell as any).key(UI);
      // The cell-less vdom schema expands children inline, so this sink keeps
      // the whole render tree materialized in this controller. The snapshot
      // walk below then reads it back through raw links, which is where the
      // per-node entity ids come from.
      uiSinkCancel = uiCell.asSchema(debugVDOMSchema).sink(() => {});
    }

    // The board's composer is gated on a resolved Profile, and the board's own
    // `#profile` create surface does not mount (see the note at the end of this
    // file), so sign in through the home space's Profile tab first. This runs
    // on the one shell the scenario uses: every `ShellIntegration` registers
    // itself as a recorded participant, so a second one for setup would put a
    // second window in the video for the sake of one form.
    if (!SEED_ON_SCREEN) {
      // Seeded before the board is ever opened, so a recording starts on a
      // board that already holds these. The low indices, so the topics the
      // scenario composes are the newest — and the ones the board shows first.
      for (let index = 0; index < SEEDED_COUNT; index++) {
        await board.result.set(
          { title: titleFor(index), agentName: "Topics authoring test" },
          ["addTopic"],
        );
      }
      // Timed adds with no renderer attached: this is the data layer's own
      // cost on a board of `SEEDED_COUNT`, with nothing rendering it.
      for (let index = 0; index < MEASURE_ADDS; index++) {
        await timedAdd(
          () =>
            board.result.set(
              { title: `Measured off ${index + 1}`, agentName: "measure" },
              ["addTopic"],
            ),
          "offscreen",
          index,
          SEEDED_COUNT + index,
        );
      }
    }

    await createProfile(shell, identity, AUTHOR);
  });

  afterAll(async () => {
    uiSinkCancel?.();
    boardSinkCancel?.();
    await cc?.dispose();
  });

  it("composes topics and comments from the UI", async () => {
    const timeline = new StepTimer();
    const page = shell.page();
    // Connected after the first load, once the worker exists.
    let profiler: CdpWorkerProfiler | undefined;
    const profiling = (phase: string) =>
      profiler !== undefined &&
      (CPUPROFILE_PHASES.has(phase) || CPUPROFILE_PHASES.has("all"));

    /** Run `body` with the worker's sampling profiler armed for `phase`. */
    const profiled = async (
      phase: string,
      label: string,
      body: () => Promise<void>,
    ) => {
      await startProfile(profiler!, phase);
      try {
        await body();
      } finally {
        // Even on failure: a profiler left running holds the worker's V8
        // sampler open for every later phase.
        await writeProfile(profiler!, phase, label);
      }
    };

    const step = async (
      label: string,
      action: () => Promise<void>,
      phase?: string,
    ) => {
      const body = phase !== undefined && profiling(phase)
        ? () => profiled(phase, label, action)
        : action;
      try {
        await timeline.run(label, body);
      } catch (cause) {
        console.log(`[topics-authoring] FAILED AT: ${label}`);
        console.log(await describePage(page).catch(() => "(no page state)"));
        throw cause;
      }
    };

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId: board.id },
      identity,
    });
    await waitForRuntimeIdle(page);

    // The profiler tracks targets from here on, so the fresh worker a reload
    // brings up is attached too, and `start()` picks the newest match.
    if (CPUPROFILE_PHASES.size > 0) {
      profiler = await CdpWorkerProfiler.connect(shell.wsEndpoint());
      const worker = await profiler.waitForWorker(RUNTIME_WORKER_URL);
      console.log(`[topics-authoring] profiling worker ${worker.url}`);
    }

    const startsEmpty = SEED_ON_SCREEN || SEEDED_COUNT === 0;
    await step(
      startsEmpty
        ? `${AUTHOR} opens an empty board`
        : `${AUTHOR} opens a board of ${SEEDED_COUNT} topics`,
      async () => {
        await waitForText(
          page,
          "body",
          startsEmpty ? "No topics yet" : titleFor(0),
        );
        // Authorship is a resolved Profile, never a free-text "posting as"
        // field, so the composer is live only because one exists.
        await waitForText(page, "body", AUTHOR);
        await waitForDisabled(page, COMPOSER_BUTTON, false);
      },
    );

    if (SEED_ON_SCREEN && SEEDED_COUNT > 0) {
      // Fill the board from the agent-facing verb while the board is on screen,
      // so the cards arrive live. One step holds the caption open and the
      // counter is rewritten per topic: wrapping each send in its own step
      // would also pay `postResultHoldMs` (800ms) each, turning a ten-second
      // fill into a minute of holds. Outside a recording
      // `presentationInteractions` is undefined and this is just the loop.
      const overlay = presentationInteractions(page);
      // With snapshots on, each append is followed by a wait for its card to
      // render and for both runtimes to quiesce, so the snapshot describes a
      // settled board rather than a half-applied one. That changes the pacing
      // of the fill, which is why it is behind the same env knob.
      const snapshotAfter = async (index: number) => {
        if (SNAPSHOT_DIR === "") return;
        await waitForText(page, "body", titleFor(index));
        await settleView(page);
        await waitForRuntimeIdle(page);
        await waitForRuntimeSynced(page);
        await uiCell.pull();
        const vdom = snapshotVdomCell(uiCell, new Set<string>(), 0);
        const renderer = await captureRendererSnapshot(page);
        const file = `${SNAPSHOT_DIR}/snap-${
          String(index + 1).padStart(2, "0")
        }.json`;
        await Deno.writeTextFile(
          file,
          JSON.stringify({ topics: index + 1, vdom, renderer }, null, 1),
        );
        console.log(`[topics-authoring] snapshot written: ${file}`);
      };
      await step(
        `Generate ${SEEDED_COUNT} topics through addTopic`,
        async () => {
          for (let index = 0; index < SEEDED_COUNT; index++) {
            await overlay?.showCaption(
              `Generating topic ${index + 1} of ${SEEDED_COUNT}…`,
            );
            await board.result.set(
              { title: titleFor(index), agentName: "Topics authoring test" },
              ["addTopic"],
            );
            await snapshotAfter(index);
          }
          await waitForText(page, "body", titleFor(SEEDED_COUNT - 1));
        },
        "seed",
      );
      // Here, not at the end: a reload replaces the worker and with it every
      // stat this reads, so the seed phase has to be read while its worker is
      // still the one on the page.
      console.log(
        "TOPICS_LIVENESS " + JSON.stringify({
          phase: "seed",
          topics: TOPIC_COUNT,
          adds: SEEDED_COUNT,
          stats: await collectLivenessStats(page),
        }),
      );
    }

    if (MEASURE_ADDS > 0) {
      // The same adds again, now with the board rendered. Same verb, same
      // board size, so the delta against the off-screen numbers above is the
      // cost of keeping the view in step rather than of the write itself.
      const onscreen = async () => {
        for (let index = 0; index < MEASURE_ADDS; index++) {
          await timedAdd(
            async () => {
              await board.result.set(
                { title: `Measured on ${index + 1}`, agentName: "measure" },
                ["addTopic"],
              );
              await settleView(page);
            },
            "onscreen",
            index,
            SEEDED_COUNT + MEASURE_ADDS + index,
          );
        }
      };
      await step("Timed adds with the board on screen", async () => {
        if (profiling("measure")) {
          await profiled("measure", "onscreen adds", onscreen);
        } else {
          await onscreen();
        }
      }, "measure");
    }

    await step(
      COMPOSED_COUNT === 1
        ? "Start a topic"
        : `Start ${COMPOSED_COUNT} topics from the composer`,
      async () => {
        for (let index = SEEDED_COUNT; index < TOPIC_COUNT; index++) {
          await composeTopic(page, titleFor(index));
        }
        await waitForText(page, "body", LAST_TITLE);
      },
      "compose",
    );

    await step(`Open "${LAST_TITLE}"`, async () => {
      await clickCellLink(page, "Open", LAST_TITLE);
      await waitForText(page, "body", "Thread");
    });

    await step(
      "Comment on it",
      async () => {
        await fillCfTextarea(
          page,
          "cf-textarea",
          `${COMMENT_PREFIX} the earlier one landing first.`,
        );
        await clickButtonWithExactText(page, "Send");
        await settleView(page);
        await waitForText(page, "body", COMMENT_PREFIX);
      },
      "comment",
    );

    if (RELOAD_AT_END) {
      await step(
        `Cold-load the board again and render all ${TOPIC_COUNT} topics`,
        async () => {
          await shell.goto({
            frontendUrl: FRONTEND_URL,
            view: { spaceName: SPACE_NAME, pieceId: board.id },
            identity,
          });
          // Armed here rather than around the whole step: the navigation
          // replaces the runtime worker, and a profile armed on the outgoing
          // one dies with its target ("Session with given id not found").
          // This measures the incoming worker rendering the board, which is
          // the cold-load cost; the pattern resume that precedes it is not
          // reachable without pausing the worker at creation.
          const render = async () => {
            await waitForRuntimeIdle(page);
            // Both ends of the list, so this waits for the whole board rather
            // than the first screenful.
            await waitForText(page, "body", FIRST_TITLE);
            await waitForText(page, "body", LAST_TITLE);
            await settleView(page);
          };
          if (profiling("reload")) {
            await profiled("reload", "cold board render", render);
          } else {
            await render();
          }
        },
      );

      // Split so a failure names which half broke: resolving and clicking the
      // link, or the detail page rendering afterwards. On a large board the
      // second half is the interesting one — a topic's reference cards read
      // its own row of the board's pivot.
      await step("Open the topmost topic from the cold list", async () => {
        // No card filter: the first "Open" in DOM order is the topmost card,
        // which is the most recently active topic.
        await clickCellLink(page, "Open");
      });

      await step("The topic detail page renders", async () => {
        await waitForText(page, "body", "Thread");
        await waitForText(page, "body", "Body");
        await settleView(page);
      }, "detail");
    }
    profiler?.close();
    // Counts, not wall clock. `actionRuns` is how many computations the
    // scheduler ran and the worker rows are where that time went; both are far
    // steadier across runs than elapsed time on a loaded machine, and they
    // measure the thing a read bound is supposed to change.
    logStepTimings("topics-authoring", timeline);
    const load = await collectBrowserLoadSummary(page, "topics-authoring");
    const worker = Object.fromEntries(
      load.worker.map((row) => [row.key, { n: row.count, total: row.total }]),
    );
    console.log(
      "TOPICS_LOAD " + JSON.stringify({
        topics: TOPIC_COUNT,
        churn: load.churn,
        ipcCount: load.ipc.reduce((sum, row) => sum + row.count, 0),
        workerIpc: load.workerIpc,
        worker,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// VDOM identity snapshots (TOPICS_SNAPSHOT_DIR)
// ---------------------------------------------------------------------------

/** One node of the persisted render tree, addressed by where it is stored. */
type VdomSnapshot =
  | {
    k: "el";
    at: string;
    name: string;
    props: [string, string][];
    kids: VdomSnapshot[];
  }
  | { k: "list"; at: string; items: VdomSnapshot[] }
  | { k: "text"; at: string; v: string }
  | { k: "cycle"; at: string }
  | { k: "other"; at: string; v: string };

/** `of:baed…#a/b/c` — the entity id plus the path inside its document. */
function addressOf(cell: any): string {
  const link = cell.getAsNormalizedFullLink();
  return `${link.id}#${[...(link.path ?? [])].join("/")}`;
}

function truncate(value: unknown, max = 120): string {
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      : JSON.stringify(value) ?? "undefined";
  } catch {
    text = "[unserializable]";
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Walk the render tree as *cells*, so each node records the entity id and path
 * it is stored at rather than only its shape. Links are followed (that is what
 * makes a mapped card list a subtree instead of an opaque reference); a link in
 * a prop position is recorded by address and not descended into, because a
 * binding's target contents are not part of the tree's structure.
 */
function snapshotVdomCell(
  cell: any,
  ancestors: ReadonlySet<string>,
  depth: number,
): VdomSnapshot {
  let resolved: any;
  try {
    resolved = cell.resolveAsCell();
  } catch {
    return { k: "other", at: "?", v: "<unresolvable>" };
  }
  const at = addressOf(resolved);
  if (ancestors.has(at)) return { k: "cycle", at };
  if (depth > 60) return { k: "other", at, v: "<depth-limit>" };
  let raw: unknown;
  try {
    raw = resolved.getRawUntyped();
  } catch {
    return { k: "other", at, v: "<unreadable>" };
  }
  return snapshotVdomValue(
    resolved,
    raw,
    at,
    new Set([...ancestors, at]),
    depth,
  );
}

function snapshotVdomValue(
  cell: any,
  raw: unknown,
  at: string,
  ancestors: ReadonlySet<string>,
  depth: number,
): VdomSnapshot {
  const child = (key: string | number, value: unknown): VdomSnapshot =>
    isLink(value)
      ? snapshotVdomCell(cell.key(key), ancestors, depth + 1)
      : snapshotVdomValue(
        cell.key(key),
        value,
        `${at}/${key}`,
        ancestors,
        depth + 1,
      );

  if (raw === null || raw === undefined) {
    return { k: "text", at, v: String(raw) };
  }
  if (typeof raw !== "object") return { k: "text", at, v: truncate(raw) };
  if (Array.isArray(raw)) {
    return {
      k: "list",
      at,
      items: raw.map((item, index) => child(index, item)),
    };
  }

  const record = raw as Record<string, unknown>;
  // A piece result renders through its [UI]; follow that indirection the way
  // the renderer does.
  if (UI in record) return child(UI, record[UI]);

  if (record.type === "vnode") {
    const props: [string, string][] = [];
    const rawProps = record.props;
    if (rawProps && typeof rawProps === "object" && !Array.isArray(rawProps)) {
      for (const key of Object.keys(rawProps).sort()) {
        const value = (rawProps as Record<string, unknown>)[key];
        if (isLink(value)) {
          let target = "<link>";
          try {
            target = addressOf(cell.key("props").key(key).resolveAsCell());
          } catch { /* target not loadable here; the marker is the answer */ }
          props.push([key, `→${target}`]);
        } else {
          props.push([key, truncate(value)]);
        }
      }
    }
    const kidsRaw = record.children;
    let kids: VdomSnapshot[] = [];
    if (isLink(kidsRaw)) {
      const list = snapshotVdomCell(cell.key("children"), ancestors, depth + 1);
      kids = list.k === "list" ? list.items : [list];
    } else if (Array.isArray(kidsRaw)) {
      kids = kidsRaw.map((item, index) =>
        isLink(item)
          ? snapshotVdomCell(
            cell.key("children").key(index),
            ancestors,
            depth + 1,
          )
          : snapshotVdomValue(
            cell.key("children").key(index),
            item,
            `${at}/children/${index}`,
            ancestors,
            depth + 1,
          )
      );
    } else if (kidsRaw !== undefined) {
      kids = [child("children", kidsRaw)];
    }
    return { k: "el", at, name: String(record.name ?? "?"), props, kids };
  }

  return {
    k: "other",
    at,
    v: `{${Object.keys(record).slice(0, 12).join(",")}}`,
  };
}

/**
 * Renderer- and DOM-side identity, read from the main thread.
 *
 * `nodes` is the applicator's node-id → DOM node map: the identity the
 * reconciler itself assigns. `cards` tags every `cf-card` element through a
 * WeakMap that survives across snapshots, so a card element that is replaced
 * rather than patched shows up as a fresh tag.
 */
async function captureRendererSnapshot(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const global = globalThis as unknown as {
      commonfabric?: { vdom?: { registry?: Map<Element, any> } };
      __topicsTags?: WeakMap<Element, number>;
      __topicsTagSeq?: number;
    };
    global.__topicsTags ??= new WeakMap<Element, number>();
    if (global.__topicsTagSeq === undefined) global.__topicsTagSeq = 0;
    const tags = global.__topicsTags;
    const tagOf = (element: Element): { tag: number; fresh: boolean } => {
      const existing = tags.get(element);
      if (existing !== undefined) return { tag: existing, fresh: false };
      const tag = ++global.__topicsTagSeq!;
      tags.set(element, tag);
      return { tag, fresh: true };
    };

    const collect = (root: Document | ShadowRoot, out: Element[]) => {
      for (const element of root.querySelectorAll("*")) {
        out.push(element);
        if (element.shadowRoot) collect(element.shadowRoot, out);
      }
    };
    const all: Element[] = [];
    collect(document, all);

    let freshTotal = 0;
    for (const element of all) if (tagOf(element).fresh) freshTotal++;

    const cards = all
      .filter((element) => element.tagName.toLowerCase() === "cf-card")
      .map((card) => {
        const subtree: Element[] = [card];
        collect(card.shadowRoot ?? ({} as ShadowRoot), subtree);
        for (const element of card.querySelectorAll("*")) {
          subtree.push(element);
          if (element.shadowRoot) collect(element.shadowRoot, subtree);
        }
        let fresh = 0;
        const subtreeTags: number[] = [];
        for (const element of subtree) {
          const entry = tagOf(element);
          subtreeTags.push(entry.tag);
          if (entry.fresh) fresh++;
        }
        return {
          tag: tagOf(card).tag,
          title: (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(
            0,
            60,
          ),
          nodes: subtree.length,
          fresh,
          tags: subtreeTags,
        };
      });

    const registry = global.commonfabric?.vdom?.registry;
    const renders: unknown[] = [];
    if (registry) {
      for (const entry of registry.values()) {
        const info = entry.renderer.getApplicator().getDebugInfo();
        const nodes: [number, string, number | null, string | null][] = [];
        for (const [id, node] of info.nodes as Map<number, Node>) {
          nodes.push([
            id,
            node.nodeName,
            (info.nodeParents as Map<number, number>).get(id) ?? null,
            node.nodeType === 3 ? (node.nodeValue ?? "").slice(0, 60) : null,
          ]);
        }
        nodes.sort((a, b) => a[0] - b[0]);
        renders.push({
          cellId: entry.cell.ref()?.id ?? null,
          nodeCount: info.nodeCount,
          listenerCount: info.listenerCount,
          totalListeners: info.totalListeners,
          rootNodeId: info.rootNodeId,
          nodes,
        });
      }
    }

    return {
      domElements: all.length,
      freshDomElements: freshTotal,
      cards,
      renders,
    };
  });
}

/**
 * Arm the worker's V8 sampling profiler for one phase.
 *
 * Profiling is instrumentation, so a failure here reports itself and lets the
 * phase run unprofiled rather than failing the scenario.
 */
async function startProfile(
  profiler: CdpWorkerProfiler,
  phase: string,
): Promise<void> {
  try {
    await profiler.start(RUNTIME_WORKER_URL, CPUPROFILE_INTERVAL_US);
  } catch (error) {
    console.warn(`[topics-authoring] profile start failed (${phase}):`, error);
  }
}

/**
 * Stop the profiler and write both artifacts: the `.cpuprofile` Chrome
 * DevTools and speedscope load, and the ranked self-time report, which is also
 * logged so a run's output carries the answer without opening a file.
 */
async function writeProfile(
  profiler: CdpWorkerProfiler,
  phase: string,
  label: string,
): Promise<void> {
  try {
    const profile = await profiler.stop();
    const prefix = `${CPUPROFILE_DIR}/topics-${TOPIC_COUNT}-${phase}`;
    await Deno.writeTextFile(
      `${prefix}.cpuprofile`,
      JSON.stringify(profile),
    );
    const report = renderProfileReport(
      profile,
      `${label} (${TOPIC_COUNT} topics)`,
    );
    await Deno.writeTextFile(`${prefix}.report.txt`, report);
    console.log(report);
    console.log(`[topics-authoring] profile written: ${prefix}.cpuprofile`);
  } catch (error) {
    console.warn(
      `[topics-authoring] profile capture failed (${phase}):`,
      error,
    );
  }
}

/**
 * Read the scheduler's liveness-rebuild stats out of the worker.
 *
 * Not through `collectBrowserLoadSummary`: that keeps the top 28 rows by
 * total, and these rows record set sizes rather than milliseconds, so they
 * would sort above every real timing and evict it. Read them by name instead,
 * and leave the shared summary measuring what it measures.
 *
 * Each row is one `logger.recordValue`/`logger.time` key: `count` is how many
 * rebuilds contributed, and for a size row `average`/`max` are nodes or edges,
 * not milliseconds.
 */
async function collectLivenessStats(
  page: Page,
): Promise<
  Record<
    string,
    { n: number; avg: number; p95: number; max: number; total: number }
  >
> {
  return await page.evaluate(async () => {
    type Stats = {
      count?: number;
      average?: number;
      p95?: number;
      max?: number;
      totalTime?: number;
    };
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: {
          getLoggerCounts?: () => Promise<
            { timing?: Record<string, Record<string, Stats>> }
          >;
        };
      };
    }).commonfabric?.rt;
    if (!rt?.getLoggerCounts) return {};
    const { timing } = await rt.getLoggerCounts();
    const round = (value: number | undefined) =>
      Number((value ?? 0).toFixed(2));
    const out: Record<
      string,
      { n: number; avg: number; p95: number; max: number; total: number }
    > = {};
    for (const [key, stats] of Object.entries(timing?.["scheduler"] ?? {})) {
      if (!key.startsWith("scheduler/liveness/")) continue;
      out[key.replace("scheduler/liveness/", "")] = {
        n: stats.count ?? 0,
        avg: round(stats.average),
        p95: round(stats.p95),
        max: round(stats.max),
        total: round(stats.totalTime),
      };
    }
    return out;
  });
}

async function composeTopic(page: Page, title: string): Promise<void> {
  await fillCfInput(page, COMPOSER_INPUT, title);
  await clickButtonWithExactText(page, "Start");
  await settleView(page);
}

/**
 * Give `identity` a Profile through the home space's Profile tab.
 *
 * The seam is `home-profile-reload-durability.test.ts`'s, copied whole because
 * each part earns its place: the tab click rides directly on `goto` (the picker
 * mounts with the panel, not after an idle checkpoint), `ensureProfileTabActive`
 * re-activates a tab that fell back to its "spaces" default (CT-1666), and the
 * settle rounds are the durability read — a profile lives in its own `inSpace`
 * child space, and a board's `#profile` wish cannot resolve it until that space
 * is durably created and loaded.
 */
async function createProfile(
  shell: ShellIntegration,
  identity: Identity,
  name: string,
): Promise<void> {
  const page = shell.page();
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(page, 'cf-tab[value="profile"]');
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
  await waitForText(page, "#home-profile-summary", name);
  for (let round = 0; round < 6; round++) {
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
  }
}

// CT-1666: navigating to the home view can reset the active tab from "profile"
// back to its "spaces" default, hiding the whole panel (`display:none`) and
// collapsing the picker to 0x0. Re-activate until it sticks. Copied from
// `home-profile.test.ts`, which carries the same workaround and the ticket.
async function profileTabHidden(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const deepFind = (sel: string): Element | null => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      }
      return null;
    };
    const panel = deepFind('cf-tab-panel[value="profile"]');
    return !panel || getComputedStyle(panel).display === "none";
  });
}

async function ensureProfileTabActive(page: Page) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

/**
 * Wait for a resolved cf-cell-link with `label`, mark its native button, and
 * issue one trusted click. With `withinCardTitled`, only a link inside the card
 * carrying that title matches — the board renders one "Open" per card. Without
 * it, the first in DOM order wins, which is the topmost card.
 *
 * Settle before marking, as `clickCfButton` does: the board keeps reflowing
 * while content above the link fills in, so the link's box moves for a few
 * frames after it first becomes clickable, and a click that resolved the old
 * box lands on shifted-away layout.
 */
async function clickCellLink(
  page: Page,
  label: string,
  withinCardTitled?: string,
): Promise<string> {
  await settleView(page);
  const token = `topics-authoring-link-${crypto.randomUUID()}`;
  await waitForCondition(
    page,
    (
      probe,
      targetLabel: string,
      cardTitle: string,
      targetToken: string,
      clickTargetAttribute: string,
    ) => {
      for (const element of probe.collect("cf-cell-link")) {
        const link = element as HTMLElement & {
          label?: string;
          link?: string;
          _resolvedCell?: unknown;
        };
        if (link.label !== targetLabel || !link.link || !link._resolvedCell) {
          continue;
        }
        if (cardTitle !== "") {
          const card = link.closest("cf-card");
          if (!card || !(card.textContent ?? "").includes(cardTitle)) continue;
        }
        const chip = link.shadowRoot?.querySelector("cf-chip");
        const button = chip?.shadowRoot?.querySelector("button");
        if (!button || !probe.isRendered(button)) continue;
        link.setAttribute("data-topics-authoring-target", targetToken);
        probe.addToken(button, clickTargetAttribute, targetToken);
        return true;
      }
      return false;
    },
    // `undefined` does not survive serialization into the page: the parameter
    // is dropped and every argument after it shifts, so the token arrives as
    // the attribute name and nothing is ever marked. "" is the empty filter.
    { args: [label, withinCardTitled ?? "", token, CLICK_TARGET_ATTR] },
  );

  const target = await page.evaluate((targetToken: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      const found = root.querySelector(
        `[data-topics-authoring-target="${targetToken}"]`,
      ) as (HTMLElement & { link?: string }) | null;
      if (found?.link) return found.link;
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
    return undefined;
  }, { args: [token] });
  assert(
    target?.startsWith("/of:"),
    `Topics link "${label}" had invalid target: ${target}`,
  );

  // Bring the target into view before the trusted click. `clickMarked` waits
  // for a stable box, and on a long board an off-screen target's box keeps
  // moving as content above it settles.
  await page.evaluate((targetToken: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      const found = root.querySelector(
        `[data-topics-authoring-target="${targetToken}"]`,
      ) as HTMLElement | null;
      if (found) {
        found.scrollIntoView({ block: "center" });
        return;
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
  }, { args: [token] });

  await clickMarked(page, token);
  return target!.slice(1);
}

/**
 * Fill a cf-textarea's inner native <textarea> and durably commit the edit.
 * Mirrors `fillCfInput`'s fillAndVerify but targets a <textarea> host: drive
 * the field like a user, then ask the host to commit() so the two-way-bound
 * draft cell flushes. (Copied from profile-embed.test.ts, which owns the same
 * seam; cf-textarea has no shared helper yet.)
 */
async function fillCfTextarea(page: Page, selector: string, value: string) {
  await waitForRuntimeIdle(page);
  const field = await page.waitForSelector(selector, { strategy: "pierce" });
  const ok = await field.evaluate(async (element: Element, nextValue) => {
    const textarea = element instanceof HTMLTextAreaElement
      ? element
      : element.shadowRoot?.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const root = textarea.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : element;
    const hostElement = host as Element & { commit?: () => Promise<void> };
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(textarea, nextValue);
    else textarea.value = nextValue;
    textarea.dispatchEvent(
      new Event("input", { bubbles: true, composed: true }),
    );
    textarea.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
    textarea.blur();
    await hostElement.commit?.();
    return textarea.value === nextValue;
  }, { args: [value] });
  assert(ok, `Unable to fill cf-textarea "${selector}"`);
}

/** Deep-text + control snapshot, printed when a step fails. */
async function describePage(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const all: Element[] = [];
    const walk = (r: Document | ShadowRoot) => {
      for (const el of r.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const deepText = (root: Document | ShadowRoot): string => {
      let t = root.textContent ?? "";
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) t += " " + deepText(el.shadowRoot);
      }
      return t.replace(/\s+/g, " ").trim();
    };
    const buttons = all
      .filter((e) => e.tagName.toLowerCase() === "cf-button")
      .map((e) =>
        `${(e.textContent ?? "").trim()}${
          (e as unknown as { disabled?: boolean }).disabled ? " [disabled]" : ""
        }`
      );
    const links = all
      .filter((e) => e.tagName.toLowerCase() === "cf-cell-link")
      .map((e) => {
        const l = e as HTMLElement & {
          label?: string;
          link?: string;
          _resolvedCell?: unknown;
        };
        return `${l.label ?? "?"}|link=${l.link ? "y" : "n"}|resolved=${
          l._resolvedCell ? "y" : "n"
        }`;
      });
    const counts: Record<string, number> = {};
    for (const l of links) counts[l] = (counts[l] ?? 0) + 1;
    return [
      "CELL_LINKS(" + links.length + "): " + JSON.stringify(counts),
      "TEXT: " + deepText(document).slice(0, 900),
      "IDS: " + JSON.stringify(all.map((e) => e.id).filter(Boolean)),
      "BUTTONS: " + JSON.stringify(buttons),
    ].join("\n");
  });
}

// NOTE — the board's own profile-create surface does not mount.
//
// `main.tsx` renders `{profileWish[UI]}` beside "Acting as" when the viewer has
// no profile, which on other patterns (see `shared-profile.test.ts`) is the
// `#profile` wish's create form carrying `#wish-profile-name-input`. On this
// board it renders nothing: after 45s the deep text reads "Acting as" directly
// followed by "Start", and no element with that id exists anywhere in the tree.
//
// This reproduces identically with `packages/patterns/topics/` reverted to its
// state on `main`, so it predates the read-schema work. The user impact is
// real: a viewer with no profile lands on a board whose composer is permanently
// disabled and offers no way to create one. Filed for its own investigation;
// this test routes around it through the home Profile tab.
