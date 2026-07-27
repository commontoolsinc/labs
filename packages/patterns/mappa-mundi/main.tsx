import {
  computed,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
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
  type Seg,
  TABS,
  TIERS,
  WHISPER,
  WHY,
  WHY3,
} from "./content.ts";
import { MAPPA_IMAGE } from "./mappa-image.ts";
import { FLAG_COUNT, LEDGER, MODE_CLASS, ROW_COUNT } from "./ordering.ts";
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
const prose = (segs: Seg[]) => segs.map((s) => s.b ? <b>{s.t}</b> : s.t);

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
 * Tap-to-reveal for the tooltips. Hover alone leaves every referent unreachable
 * on a touch screen, and the source document had the same problem — it solved
 * it by pinning the tooltip to the bottom of the viewport rather than beside
 * the element it belongs to. Doing the same here means one shared sheet driven
 * by one cell, instead of a reactive class on all ~216 annotated elements.
 *
 * Tapping something with no referent closes the sheet, which is also how you
 * dismiss it.
 */
const showTip = handler<void, { text: string; tip: Writable<string> }>(
  (_, { text, tip }) => tip.set(text),
);

const hideTip = handler<void, { tip: Writable<string> }>(
  (_, { tip }) => tip.set(""),
);

const STATUS_KEY = [
  { cls: "cstat s-live", term: "live", gloss: "shipping" },
  { cls: "cstat s-partial", term: "partial", gloss: "incomplete" },
  { cls: "cstat s-latent", term: "latent", gloss: "in Fabric, unused" },
  { cls: "cstat s-stranded", term: "stranded", gloss: "built, unwired" },
  { cls: "cstat s-absent", term: "absent", gloss: "not built" },
];

// ------------------------------------------------------------------- fragments

const chipRow = (chips: Chip[], extra: string, tip: Writable<string>) => (
  <div className="chips">
    {chips.map((c) => {
      const vm = chipVM(c, extra);
      return (
        <span
          className={vm.cls}
          data-tip={vm.tip}
          onClick={showTip({ text: vm.tip, tip })}
        >
          {vm.label}
          <span className={vm.codeCls}>{vm.code}</span>
        </span>
      );
    })}
  </div>
);

const claimBlock = (kind: string, label: string, segs: Seg[]) => (
  <p className="cblock">
    <span className={"bl " + kind}>{label}</span>
    <span>{prose(segs)}</span>
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

export interface MappaMundiOutput {
  [NAME]: string;
  [UI]: VNode;
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
  // The referent currently pinned open by tap; "" means the sheet is closed.
  const tip = new Writable.perSession("");

  // Sorting and filtering are CSS; only this class is reactive. See ordering.ts.
  const ledgerCls = computed(() =>
    "ledger " + (MODE_CLASS[sortMode.get()] ?? "")
  );

  return {
    [NAME]: "Common Fabric mappa mundi",
    activeTab,
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
                    {WHY.paras.map((p) => <p>{p}</p>)}
                  </div>
                  <figure className="fmap">
                    <img src={MAPPA_IMAGE} alt={FIGURE.alt} />
                    <figcaption>{FIGURE.caption}</figcaption>
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
                              </div>
                            </div>
                            <div className="boundary">
                              <span className="bl">its gate</span>
                              <div>{l.gate}</div>
                            </div>
                            {chipRow(l.chips, "", tip)}
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
                        </div>
                        <div>
                          {t.groups.map((g) => (
                            <div className="grp">
                              <span className={"glabel l-" + g.layer}>
                                {g.label}
                              </span>
                              {chipRow(g.chips, "l-" + g.layer, tip)}
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
                                  onClick={showTip({ text: r.tip, tip })}
                                >
                                  {r.name}
                                </span>
                                <span className={r.layerCls}>
                                  {r.layerText}
                                </span>
                                <span className={r.statusCls}>{r.status}</span>
                                <span
                                  className={r.flagCls}
                                  data-tip={r.flag}
                                  onClick={showTip({ text: r.flag, tip })}
                                >
                                  {r.flagMark}
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
              </cf-tabs>

              <div
                className={computed(() =>
                  tip.get() ? "tipsheet open" : "tipsheet"
                )}
                role="status"
                onClick={hideTip({ tip })}
              >
                <span className="tipx">×</span>
                <span>{tip}</span>
              </div>
            </div>
          </div>
        </cf-screen>
      </cf-theme>
    ),
  };
});
