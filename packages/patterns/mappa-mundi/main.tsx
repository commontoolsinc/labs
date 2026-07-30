import {
  computed,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import {
  type Chip,
  CLAIMS,
  CLAIMS_INTRO,
  FIGURE,
  FOOTER,
  HEADER,
  LAYERS,
  LEDGER_INTRO,
  PARADIGM,
  REACH_INTRO,
  SECTIONS,
  TABS,
  TIERS,
  WHISPER,
  WHY,
  WHY3,
} from "./content.ts";
import { MAPPA_IMAGE } from "./mappa-image.ts";
import { paragraphs, parseMarkup } from "./markup.ts";
import { FLAG_COUNT, LEDGER, MODE_CLASS, ROW_COUNT } from "./ordering.ts";
import {
  ANCHOR_TEXT,
  countCss,
  type Discussion,
  type DiscussionView,
  threadRows,
  WHY_ESSAY,
  WHY_MAP,
} from "./discussion.ts";
import { STYLES } from "./styles.ts";

/**
 * The Common Fabric mappa mundi: a five-tab world-picture of the platform.
 *
 * The source document drove its tabs and its concern ordering by mutating the
 * DOM from a script. Here the state is reactive instead: the tab rides cf-tabs'
 * `$value` binding, and the ledger's sort mode drives one reactive class name.
 *
 * All content is static, so the JSX below maps over plain module-scope arrays.
 * The ledger deliberately does NOT re-render when you sort it — its rows are
 * emitted once and CSS reorders and filters them. `ordering.ts` explains why.
 *
 * Sharing boundary: both cells are `perSession`. Which tab you are on and how
 * you have ordered the ledger are navigation, not durable preferences: opening
 * the piece in a second tab should start at the top again.
 */

// ---------------------------------------------------------------- view models

/** A run of prose, rendered with its bold spans intact. */
const prose = (markup: string) =>
  parseMarkup(markup).map((s) => s.b ? <b>{s.t}</b> : s.t);

interface ChipVM {
  cls: string;
  label: string;
  code: string;
  codeCls: string;
  tip: string;
}

const chipVM = (chip: Chip, extra: string): ChipVM => ({
  cls: extra ? "chip " + extra : "chip",
  label: chip.label,
  code: chip.code ? "· " + chip.code : "",
  codeCls: chip.code ? "c" : "",
  tip: chip.tip,
});

const SORTS = [
  { id: "maturity", label: "maturity" },
  { id: "layer", label: "layer" },
  { id: "open", label: "open questions" },
];

/** One implementation, bound to a different mode at each of the three sites. */
const setSort = handler<void, { mode: string; sortMode: Writable<string> }>(
  (_, { mode, sortMode }) => sortMode.set(mode),
);

/**
 * Opening a place in the map. The cell holds an ANCHOR KEY, and the panel looks
 * the referent text up from the static registry — so the same tap that reveals
 * what a concern means also opens its thread.
 *
 * Tapping something with no anchor closes the panel, which is also how it is
 * dismissed.
 */
const openAt = handler<void, { anchor: string; open: Writable<string> }>(
  (_, { anchor, open }) => open.set(anchor),
);

/** Follow a thread back to the place it hangs off, and open it there. */
const goTo = handler<void, {
  anchor: string;
  tab: string;
  activeTab: Writable<string>;
  open: Writable<string>;
}>((_, { anchor, tab, activeTab, open }) => {
  activeTab.set(tab);
  open.set(anchor);
});

const closePanel = handler<void, { open: Writable<string> }>(
  (_, { open }) => open.set(""),
);

/**
 * Post a comment. `push` is the mergeable append, so two people commenting at
 * once merge instead of clobbering; the durable order is the server's, which is
 * why nothing here sorts.
 *
 * Date.now() is legal in a handler (coarsened to one second) and would throw in
 * a computed. It is stored for display only.
 */
const postComment = handler<{ body?: string }, {
  discussion: Writable<Discussion>;
  open: Writable<string>;
  draft: Writable<string>;
  author: unknown;
}>(({ body }, { discussion, open, draft, author }) => {
  const text = (body ?? draft.get() ?? "").trim();
  const anchor = open.get() ?? "";
  if (!text || !anchor) return;
  discussion.key("items").push({
    anchor,
    author,
    body: text,
    stampedAt: Date.now(),
  });
  draft.set("");
});

/**
 * The agent-facing post. Everything comes from the payload, so it works from
 * `cf piece call` where the session-scoped `open` / `draft` cells the UI uses
 * do not resolve.
 */
const addComment = handler<{ anchor: string; body: string }, {
  discussion: Writable<Discussion>;
  author: unknown;
}>(({ anchor, body }, { discussion, author }) => {
  const text = (body ?? "").trim();
  const at = (anchor ?? "").trim();
  if (!text || !at) return;
  discussion.key("items").push({
    anchor: at,
    author,
    body: text,
    stampedAt: Date.now(),
  });
});

const STATUS_KEY = [
  { cls: "cstat s-live", term: "live", gloss: "shipping" },
  { cls: "cstat s-partial", term: "partial", gloss: "incomplete" },
  { cls: "cstat s-latent", term: "latent", gloss: "in Fabric, unused" },
  { cls: "cstat s-stranded", term: "stranded", gloss: "built, unwired" },
  { cls: "cstat s-absent", term: "absent", gloss: "not built" },
];

// ------------------------------------------------------------------- fragments

const chipRow = (chips: Chip[], extra: string, open: Writable<string>) => (
  <div className="chips">
    {chips.map((c) => {
      const vm = chipVM(c, extra);
      return (
        <span
          className={vm.cls}
          data-tip={vm.tip}
          data-a={c.id}
          onClick={openAt({ anchor: c.id, open })}
        >
          {vm.label}
          <span className={vm.codeCls}>{vm.code}</span>
          <span className="ccount"></span>
        </span>
      );
    })}
  </div>
);

const claimBlock = (kind: string, label: string, markup: string) => (
  <p className="cblock">
    <span className={"bl " + kind}>{label}</span>
    <span>{prose(markup)}</span>
  </p>
);

const theme = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  borderRadius: "14px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#333B76",
    primaryForeground: "#FBFCFE",
    background: "#EBEEF4",
    surface: "#FBFCFE",
    surfaceHover: "#F2F5F9",
    text: "#141824",
    textMuted: "#6B7488",
    border: "#D2D8E3",
    borderMuted: "#E4E8F0",
    accent: "#C15A48",
    accentForeground: "#FBFCFE",
    success: "#2E8B57",
    warning: "#B0801C",
    error: "#B24A3E",
  },
};

// deno-lint-ignore no-empty-interface
interface MappaMundiInput {}

/**
 * A #mappamundi of the Common Fabric, carrying an anchored #discussion that an
 * agent can read whole and post into.
 */
export interface MappaMundiOutput {
  [NAME]: string;
  [UI]: VNode;
  /**
   * Every thread in the space, each comment carrying the anchor it hangs off.
   * Space-scoped, so unlike `activeTab` this is readable from outside a
   * session — `cf piece get discussion` works.
   *
   * Optional, like `addComment`: the runtime rejects adding a REQUIRED result
   * field to a piece that already exists ("newly required result field has no
   * default"), so a contract that grows has to grow optionally.
   */
  discussion?: Writable<DiscussionView>;
  /** Post a comment: `cf piece call ... addComment '{"anchor":"…","body":"…"}'`. */
  addComment?: Stream<{ anchor: string; body: string }>;
  /**
   * The tab on screen, so a host sharing the session can deep-link into a
   * region of the map. Session-scoped: it holds a value inside a session and
   * resolves to nothing outside one, so `cf piece get activeTab` cannot read
   * it even with `--step`.
   */
  activeTab: Writable<string>;
}

export default pattern<MappaMundiInput, MappaMundiOutput>(() => {
  const activeTab = new Writable.perSession("why");
  const sortMode = new Writable.perSession("maturity");
  // The place in the map currently open; "" means the panel is closed.
  const open = new Writable.perSession("");
  // The comment being written. perUser so it survives a reload for one person.
  const draft = new Writable.perUser("");
  // Every thread in the space. Object-wrapped, not a bare array: a bare
  // Writable<T[]> holding a nested live cell unwraps to a weak object.
  const discussion = new Writable.perSpace<Discussion>({ items: [] });

  // The viewer, resolved from the runtime — never a typed-in name.
  const profileWish = wish({ query: "#profile" });

  const referent = computed(() => ANCHOR_TEXT[open.get() ?? ""] ?? "");
  // Verified safe: filtering a reactive array re-renders correctly on
  // membership change. Never reorder it — that renders corrupt output.
  const thread = computed(() =>
    (discussion.get()?.items ?? []).filter((c) =>
      c.anchor === (open.get() ?? "")
    )
  );
  const threadCount = computed(() => {
    const n = (discussion.get()?.items ?? []).filter((c) =>
      c.anchor === (open.get() ?? "")
    ).length;
    return n === 0
      ? "no comments yet"
      : n === 1
      ? "1 comment"
      : n + " comments";
  });
  const talk = computed(() => threadRows(discussion.get()?.items ?? []));
  const talkEmpty = computed(() =>
    (discussion.get()?.items ?? []).length === 0 ? "talk empty" : "talk"
  );
  // One reactive value fills in every count marker. See discussion.ts.
  const counts = computed(() => countCss(discussion.get()?.items ?? []));

  // Sorting and filtering are CSS; only this class is reactive. See ordering.ts.
  const ledgerCls = computed(() =>
    "ledger " + (MODE_CLASS[sortMode.get()] ?? "")
  );

  return {
    [NAME]: "Common Fabric mappa mundi",
    activeTab,
    discussion,
    addComment: addComment({ discussion, author: profileWish.result }),
    [UI]: (
      <cf-theme theme={theme}>
        <cf-screen>
          <div className="mm">
            <style>{STYLES}</style>
            <div className="wrap">
              <header className="suite-head">
                <p className="eyebrow lbl">{HEADER.eyebrow}</p>
                <h1 className="suite-h1">
                  <b>Common Fabric</b> mappa mundi
                </h1>
                <p className="dek">{HEADER.dek}</p>
              </header>

              <cf-tabs $value={activeTab}>
                <cf-tab-list>
                  {TABS.map((t) => <cf-tab value={t.id}>{t.label}</cf-tab>)}
                </cf-tab-list>

                {/* ---------------------------------------------- why */}
                <cf-tab-panel value="why">
                  <div className="whytext">
                    <h3>{WHY.title}</h3>
                    {paragraphs(WHY.body).map((p) => <p>{p}</p>)}
                    <button
                      type="button"
                      className="dmark"
                      data-a={WHY_ESSAY}
                      onClick={openAt({ anchor: WHY_ESSAY, open })}
                    >
                      discuss<span className="ccount"></span>
                    </button>
                  </div>
                  <figure className="fmap">
                    <img src={MAPPA_IMAGE} alt={FIGURE.alt} />
                    <figcaption>
                      {FIGURE.caption}
                      <button
                        type="button"
                        className="dmark"
                        data-a={WHY_MAP}
                        onClick={openAt({ anchor: WHY_MAP, open })}
                      >
                        discuss<span className="ccount"></span>
                      </button>
                    </figcaption>
                  </figure>
                </cf-tab-panel>

                {/* ----------------------------------------- promises */}
                <cf-tab-panel value="claims">
                  <div className="claims-intro">
                    <p className="ci-h">{CLAIMS_INTRO[0]}</p>
                    <p>{CLAIMS_INTRO[1]}</p>
                  </div>
                  {
                    /*
                    Native <details>, as the source document used. cf-collapsible
                    animates a measured height, and these are first rendered
                    inside a hidden tab panel — it measures zero there and stays
                    clipped shut even with `open` set.
                  */
                  }
                  {CLAIMS.map((c) => (
                    <details className="claim" open>
                      <summary>
                        <span className="cname">{c.name}</span>
                        <span className="ctag">
                          {c.tag} <i>{c.principle}</i>
                        </span>
                      </summary>
                      <div className="claim-body">
                        <p className="claim-lede">{c.lede}</p>
                        <button
                          type="button"
                          className="dmark"
                          data-a={c.id}
                          onClick={openAt({ anchor: c.id, open })}
                        >
                          discuss<span className="ccount"></span>
                        </button>
                        {claimBlock("villain", "Status quo", c.villain)}
                        {claimBlock("benefit", "With fabric", c.benefit)}
                        {claimBlock("mech", "Mechanism", c.mech)}
                      </div>
                    </details>
                  ))}
                </cf-tab-panel>

                {/* -------------------------------------- three layers */}
                <cf-tab-panel value="orient">
                  <section>
                    <h2>
                      <span className="n">{SECTIONS[0].glyph}</span>{" "}
                      {SECTIONS[0].title}
                    </h2>
                    <p className="sub">{SECTIONS[0].sub[0]}</p>
                    <div className="pgwrap">
                      <div className="paradigms">
                        <div className="pg-corner"></div>
                        {PARADIGM.names.map((n, i) => (
                          <div className={i === 2 ? "pg-name fab" : "pg-name"}>
                            {n}
                          </div>
                        ))}
                        <div className="pg-rail" aria-hidden="true">
                          <span className="vc top">open</span>
                          <span className="vc bot">guarded</span>
                        </div>
                        {PARADIGM.cells.map((c) => (
                          <div
                            className={"pg-cell r-" + c.row +
                              (c.fab ? " fab" : "")}
                          >
                            {c.label}
                            {c.epigraph
                              ? <span className="pge">{c.epigraph}</span>
                              : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="whisper">{prose(WHISPER)}</p>
                  </section>

                  <hr className="rule" />

                  <section>
                    <h2>
                      <span className="n">{SECTIONS[1].glyph}</span>{" "}
                      {SECTIONS[1].title}
                    </h2>
                    <p className="sub">{SECTIONS[1].sub[0]}</p>
                    <div className="why3">
                      {WHY3.map((w, i) => (
                        <div
                          className={"w3 t-" + ["edge", "shell", "core"][i]}
                        >
                          <span className="w3k">{w.key}</span> {prose(w.body)}
                          <button
                            type="button"
                            className="dmark"
                            data-a={w.id}
                            onClick={openAt({ anchor: w.id, open })}
                          >
                            discuss<span className="ccount"></span>
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="sub" style="margin-top:1.2rem">
                      {SECTIONS[1].sub[1]}
                    </p>
                  </section>

                  <hr className="rule" />

                  <section>
                    <h2>
                      <span className="n">{SECTIONS[2].glyph}</span>{" "}
                      {SECTIONS[2].title}
                    </h2>
                    <p className="sub">{SECTIONS[2].sub[0]}</p>
                    <div className="stackwrap">
                      <div className="vrail" aria-hidden="true">
                        <span className="vc top">open · invention</span>
                        <span className="vc bot">guarded · trust</span>
                      </div>
                      <div className="layers">
                        {LAYERS.map((l) => (
                          <div className={"layer " + l.tone}>
                            <div className="lhead">
                              <div>
                                <div className="name">
                                  {l.name} <span className="tag">{l.tag}</span>
                                </div>
                                <p className="what">{prose(l.what)}</p>
                                <button
                                  type="button"
                                  className="dmark"
                                  data-a={l.id}
                                  onClick={openAt({
                                    anchor: l.id,
                                    open,
                                  })}
                                >
                                  discuss<span className="ccount"></span>
                                </button>
                              </div>
                            </div>
                            <div className="boundary">
                              <span className="bl">its gate</span>
                              <div>{l.gate}</div>
                            </div>
                            {chipRow(l.chips, "", open)}
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <hr className="rule" />

                  <section className="close">
                    <footer>{FOOTER}</footer>
                  </section>
                </cf-tab-panel>

                {/* ----------------------------------- loom prototype */}
                <cf-tab-panel value="reach">
                  <p className="panel-intro">{prose(REACH_INTRO)}</p>
                  <div className="tiers">
                    {TIERS.map((t) => (
                      <div className="tier">
                        <div className="tid">
                          <span className="ttag">{t.ttag}</span>
                          <span className="tname">{t.tname}</span>
                          <span className="tline">{t.tline}</span>
                          <span className="thealth">{t.health}</span>
                          <button
                            type="button"
                            className="dmark"
                            data-a={t.id}
                            onClick={openAt({ anchor: t.id, open })}
                          >
                            discuss<span className="ccount"></span>
                          </button>
                        </div>
                        <div>
                          {t.groups.map((g) => (
                            <div className="grp">
                              <span className={"glabel l-" + g.layer}>
                                {g.label}
                              </span>
                              {chipRow(g.chips, "l-" + g.layer, open)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </cf-tab-panel>

                {/* ---------------------------------------- concerns */}
                <cf-tab-panel value="ledger">
                  <p className="cintro">{prose(LEDGER_INTRO)}</p>
                  <p className="ckey">
                    {STATUS_KEY.map((k) => (
                      <span>
                        <span className={k.cls}>{k.term}</span> {k.gloss}
                      </span>
                    ))}
                    <span>
                      <span className="kf">⚑</span>{" "}
                      an open question to interrogate; hover it ({FLAG_COUNT}
                      {" "}
                      across {ROW_COUNT} concerns)
                    </span>
                  </p>

                  <div className={ledgerCls}>
                    {LEDGER.map((band) => (
                      <>
                        <div className={band.cls}>
                          <span className="cbt">{band.title}</span>
                          <span className="cbs">{band.sub}</span>
                        </div>
                        {band.domains.map((dom) => (
                          <div className={dom.cls}>
                            <h3>
                              {dom.title}
                              <span className="cflagn">{dom.flagNote}</span>
                            </h3>
                            <div className="cstrip">
                              {dom.strip.map((s) => <i style={s.style}></i>)}
                            </div>
                            {dom.rows.map((r) => (
                              <div className={r.cls}>
                                <span
                                  className="cname"
                                  data-tip={r.tip}
                                  data-a={r.selfKey}
                                  onClick={openAt({
                                    anchor: r.selfKey,
                                    open,
                                  })}
                                >
                                  {r.name}
                                  <span className="ccount"></span>
                                </span>
                                <span className={r.layerCls}>
                                  {r.layerText}
                                </span>
                                <span className={r.statusCls}>{r.status}</span>
                                <span
                                  className={r.flagCls}
                                  data-tip={r.flag}
                                  data-a={r.flagKey}
                                  onClick={openAt({
                                    anchor: r.flagKey,
                                    open,
                                  })}
                                >
                                  {r.flagMark}
                                  <span className="ccount"></span>
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    ))}
                  </div>

                  <div className="csort" role="group" aria-label="Row order">
                    <span>order by</span>
                    {SORTS.map((s) => (
                      <button
                        type="button"
                        className={computed(() =>
                          sortMode.get() === s.id ? "csb on" : "csb"
                        )}
                        aria-pressed={computed(() =>
                          sortMode.get() === s.id ? "true" : "false"
                        )}
                        onClick={setSort({ mode: s.id, sortMode })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </cf-tab-panel>
                {/* ------------------------------------- discussion */}
                <cf-tab-panel value="talk">
                  <p className="panel-intro">
                    <b>Everything said about the map.</b>{" "}
                    Newest first. Each entry names the place it hangs off —
                    follow it to read the thread in context.
                  </p>
                  <div className={talkEmpty}>
                    <p className="talknone">
                      Nothing yet. Tap a concern, a chip, or a promise and say
                      something.
                    </p>
                    {talk.map((t) => (
                      <div className="trow">
                        <button
                          type="button"
                          className="tgo"
                          onClick={goTo({
                            anchor: t.anchor,
                            tab: t.tab,
                            activeTab,
                            open,
                          })}
                        >
                          {t.label}
                        </button>
                        <div className="tbody">
                          <cf-profile-badge
                            $profile={t.author}
                            variant="chip"
                          />
                          <span>{t.body}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </cf-tab-panel>
              </cf-tabs>

              {
                /*
                The panel is ALWAYS in the DOM and hidden with CSS. It must be:
                $value and $profile below are bidirectional bindings, and a
                binding inside a {computed(() => <jsx/>)} subtree throws and
                blanks the whole pattern. Only the class name is reactive.
              */
              }
              <div
                className={computed(() => {
                  // Read both before deciding: a short-circuited `.get()` is a
                  // dependency the computed may never learn it has.
                  const at = open.get() ?? "";
                  const tab = activeTab.get() ?? "";
                  // The Discussion tab already lists every thread, so the
                  // floating panel there would only cover its own content.
                  return at !== "" && tab !== "talk" ? "panel open" : "panel";
                })}
              >
                <div className="phead">
                  <span className="pcount">{threadCount}</span>
                  <button
                    type="button"
                    className="px"
                    onClick={closePanel({ open })}
                  >
                    ×
                  </button>
                </div>

                <p className="pref">{referent}</p>

                <div className="pthread">
                  {thread.map((c) => (
                    <div className="pmsg">
                      <cf-profile-badge $profile={c.author} variant="chip" />
                      <span className="pbody">{c.body}</span>
                    </div>
                  ))}
                </div>

                <div className="pcompose">
                  <cf-input
                    $value={draft}
                    placeholder="Add a comment"
                    oncf-submit={postComment({
                      discussion,
                      open,
                      draft,
                      author: profileWish.result,
                    })}
                  />
                  <cf-button
                    onClick={postComment({
                      discussion,
                      open,
                      draft,
                      author: profileWish.result,
                    })}
                  >
                    Post
                  </cf-button>
                </div>
              </div>

              {/* every comment count, in one reactive value */}
              <style>{counts}</style>
            </div>
          </div>
        </cf-screen>
      </cf-theme>
    ),
  };
});
