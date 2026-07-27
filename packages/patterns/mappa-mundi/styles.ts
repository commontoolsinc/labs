// Presentation for the mappa mundi document.
//
// Ported from the source artifact and scoped under `.mm` so the document's own
// palette cannot collide with the cf-theme custom properties around it. Only
// rules the markup actually uses are carried over; the artifact's dead
// selectors (the vestigial vector filter bar, the unused evidence rows, the
// markdown renderer) are dropped.
// This must stay a plain literal: SES rejects a computed top-level value, so
// the layer-sort rules below are written out rather than generated. They are
// pinned against LAYER_ORDER by ordering.test.ts.
export const STYLES = `

.mm{
  --bg:#EBEEF4; --panel:#FBFCFE; --panel2:#F2F5F9; --panel3:#E9EDF4;
  --ink:#141824; --ink2:#3F4759; --ink3:#6B7488; --hair:#D2D8E3; --hair2:#E4E8F0;
  --core:#333B76; --shell:#2C7C85; --edge:#C15A48;
  --accent:#C15A48;
  --good:#2E8B57; --warn:#B0801C; --crit:#B24A3E;
  --shadowcard:0 1px 2px rgba(20,25,40,.05),0 10px 30px rgba(20,25,40,.06);
  background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  line-height:1.6; -webkit-font-smoothing:antialiased;
}
@media (prefers-color-scheme:dark){
  .mm{
    --bg:#0A0C11; --panel:#13161E; --panel2:#191D27; --panel3:#1F2530;
    --ink:#ECEEF4; --ink2:#B1B9C8; --ink3:#7B8494; --hair:#252A35; --hair2:#1E232D;
    --core:#8F98E2; --shell:#5AC3CD; --edge:#EB8D7C;
    --accent:#EB8D7C;
    --good:#43C77E; --warn:#E3AE3E; --crit:#EA7060;
    --shadowcard:0 1px 2px rgba(0,0,0,.32),0 12px 34px rgba(0,0,0,.4);
  }
}
.mm *{box-sizing:border-box}
.mm .wrap{max-width:1140px;margin:0 auto;padding:clamp(1.3rem,4vw,3rem) clamp(1rem,4vw,2.4rem) 4rem}
.mm .lbl{font-family:ui-monospace,Menlo,monospace;font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3)}
.mm :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:5px}

/* hero */
.mm .eyebrow{margin:0 0 1rem;display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center}
.mm .suite-h1{font-size:clamp(2.3rem,6vw,3.8rem);line-height:1;letter-spacing:-.03em;font-weight:300;margin:.5rem 0 1rem;text-wrap:balance}
.mm .suite-h1 b{font-weight:820}
.mm .dek{font-size:clamp(1.05rem,1.7vw,1.3rem);color:var(--ink2);max-width:56ch;margin:0 0 .4rem;font-weight:350}
.mm .suite-head{margin-bottom:1.4rem}

.mm .rule{height:1px;background:var(--hair);border:0;margin:2.8rem 0}
.mm h2{font-size:.98rem;letter-spacing:.02em;font-weight:750;margin:0 0 .35rem;display:flex;gap:.6rem;align-items:baseline}
.mm h2 .n{font-family:ui-monospace,Menlo,monospace;font-size:.72rem;color:var(--accent);letter-spacing:.1em}
.mm .sub{color:var(--ink3);font-size:.92rem;margin:0 0 1.5rem;max-width:70ch}
.mm .panel-intro{color:var(--ink2);font-size:1.02rem;max-width:70ch;margin:0 0 1.6rem}
.mm .panel-intro b{color:var(--ink)}

/* why panel */
.mm .whytext{max-width:68ch}
.mm .whytext h3{font-size:1.35rem;font-weight:750;letter-spacing:-.02em;margin:0 0 .6rem;color:var(--ink2)}
.mm .whytext p{color:var(--ink2);font-size:1.05rem;line-height:1.65;margin:0 0 1rem}

/* paradigm alignment band */
.mm .pgwrap{overflow-x:auto;background:var(--panel);border:1px solid var(--hair);border-radius:14px;padding:1.5rem 1.6rem;box-shadow:var(--shadowcard)}
.mm .paradigms{display:grid;grid-template-columns:46px repeat(3,minmax(134px,1fr));gap:.75rem .85rem;min-width:528px}
.mm .pg-corner{grid-column:1;grid-row:1}
.mm .pg-name{font-family:ui-monospace,Menlo,monospace;font-size:.64rem;letter-spacing:.11em;text-transform:uppercase;color:var(--ink3);padding:0 .1rem .65rem;border-bottom:1px dashed var(--hair);align-self:end}
.mm .pg-name.fab{color:var(--accent);font-weight:600}
.mm .pg-rail{grid-column:1;grid-row:2 / 5;position:relative}
.mm .pg-rail::before{content:"";position:absolute;left:38px;top:3px;bottom:3px;width:4px;border-radius:4px;background:linear-gradient(to bottom,var(--edge),var(--shell),var(--core));opacity:.85}
.mm .pg-rail .vc{left:4px;width:16px}
.mm .pg-cell{font-size:.92rem;padding:.78rem .98rem;border-radius:8px;background:var(--panel2);border:1px solid var(--hair2);border-left:3px solid var(--rt);line-height:1.4;color:var(--ink2)}
.mm .r-edge{--rt:var(--edge)} .mm .r-mid{--rt:var(--shell)} .mm .r-core{--rt:var(--core)}
.mm .pg-cell.fab{background:color-mix(in srgb,var(--accent) 7%,var(--panel));color:var(--ink);font-weight:560}
.mm .pg-cell .pge{display:block;font-family:ui-monospace,Menlo,monospace;font-size:.6rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);font-weight:600;margin-top:.3rem}
.mm .whisper{font-family:ui-monospace,Menlo,monospace;font-size:.72rem;color:var(--ink3);margin:.9rem .2rem 0}
.mm .whisper b{color:var(--ink2);font-weight:600}

/* why three */
.mm .why3{display:flex;flex-direction:column;gap:.9rem;max-width:74ch}
.mm .w3{font-size:1rem;line-height:1.6;color:var(--ink2);padding-left:1rem;border-left:3px solid var(--wt,var(--hair))}
.mm .w3 .w3k{font-weight:750;color:var(--ink);border-left:0}
.mm .w3.t-edge{--wt:var(--edge)} .mm .w3.t-shell{--wt:var(--shell)} .mm .w3.t-core{--wt:var(--core)}
.mm .w3 b{color:var(--ink);font-weight:640}

/* layers */
.mm .stackwrap{display:grid;grid-template-columns:26px 1fr;gap:0 clamp(.7rem,2vw,1.15rem)}
.mm .vrail{position:relative}
.mm .vrail::before{content:"";position:absolute;left:10px;top:5px;bottom:5px;width:4px;border-radius:4px;background:linear-gradient(to bottom,var(--edge),var(--shell),var(--core));opacity:.85}
.mm .vc{position:absolute;left:-3px;width:26px;text-align:center;writing-mode:vertical-rl;text-orientation:mixed;font-family:ui-monospace,Menlo,monospace;font-size:.57rem;letter-spacing:.13em;text-transform:uppercase;color:var(--ink3)}
.mm .vc.top{top:2px} .mm .vc.bot{bottom:2px;color:var(--core)}
.mm .layers{display:flex;flex-direction:column;gap:1rem}
.mm .layer{background:var(--panel);border:1px solid var(--hair);border-top:3px solid var(--tone);border-radius:14px;padding:1.3rem 1.35rem 1.15rem;box-shadow:var(--shadowcard)}
.mm .layer.core{--tone:var(--core)} .mm .layer.shell{--tone:var(--shell)} .mm .layer.edge{--tone:var(--edge)}
.mm .lhead{display:grid;grid-template-columns:1fr auto;gap:.6rem 1rem;align-items:start;margin-bottom:1rem}
.mm .lhead .name{font-size:1.5rem;font-weight:780;letter-spacing:-.02em;line-height:1;display:flex;align-items:center;gap:.6rem}
.mm .lhead .tag{font-size:.98rem;color:var(--ink3);font-weight:400;letter-spacing:-.005em}
.mm .lhead .what{color:var(--ink2);font-size:.98rem;margin:.5rem 0 0;max-width:64ch}
.mm .lhead .what b{color:var(--ink);font-weight:640}
.mm .boundary{background:var(--panel2);border:1px solid var(--hair2);border-radius:9px;padding:.6rem .8rem;margin-bottom:1rem;font-size:.86rem;color:var(--ink2);display:flex;gap:.55rem;align-items:baseline}
.mm .boundary .bl{font-family:ui-monospace,Menlo,monospace;font-size:.63rem;letter-spacing:.11em;text-transform:uppercase;color:var(--tone);white-space:nowrap;padding-top:.1rem}

.mm .chips{display:flex;flex-wrap:wrap;gap:.42rem}
.mm .chip{font-size:.88rem;padding:.5rem .75rem;border-radius:8px;background:var(--panel2);border:1px solid var(--hair);color:var(--ink);display:inline-flex;align-items:center;gap:.4rem;line-height:1.2}
.mm .chip .c{font-family:ui-monospace,Menlo,monospace;font-size:.72rem;color:var(--ink3)}

/* reachability tiers */
.mm .tiers{display:flex;flex-direction:column;gap:.8rem}
.mm .tier{background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:1.1rem 1.2rem;box-shadow:var(--shadowcard);display:grid;grid-template-columns:minmax(190px,240px) 1fr;gap:.5rem 1.4rem}
.mm .tier .tid{display:flex;flex-direction:column;gap:.3rem}
.mm .tier .ttag{font-family:ui-monospace,Menlo,monospace;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);font-weight:600}
.mm .tier .tname{font-size:1.05rem;font-weight:720;letter-spacing:-.01em;line-height:1.15}
.mm .tier .tline{font-size:.83rem;color:var(--ink3);line-height:1.4}
.mm .tier .thealth{font-family:ui-monospace,Menlo,monospace;font-size:.68rem;color:var(--ink2);display:inline-flex;gap:.4rem;align-items:center;margin-top:.1rem}
.mm .tiers .chip{border-left:3px solid var(--hair)}
.mm .tiers .chip.l-core{border-left-color:var(--core)}
.mm .tiers .chip.l-shell{border-left-color:var(--shell)}
.mm .tiers .chip.l-edge{border-left-color:var(--edge)}
.mm .grp{display:flex;flex-direction:column;gap:.4rem}
.mm .grp+.grp{margin-top:.7rem}
.mm .glabel{font-family:ui-monospace,Menlo,monospace;font-size:.64rem;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
.mm .glabel.l-shell{color:var(--shell)} .mm .glabel.l-edge{color:var(--edge)} .mm .glabel.l-core{color:var(--core)}

/* concerns inventory */
.mm .cintro{color:var(--ink2);font-size:1rem;max-width:76ch;margin:0 0 .6rem}
.mm .cintro b{color:var(--ink)}
.mm .ckey{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem;font-family:ui-monospace,Menlo,monospace;font-size:.7rem;color:var(--ink3);margin:0 0 1.5rem;align-items:center}
.mm .ckey .kf{color:var(--accent);font-weight:700}
.mm .csort{position:sticky;bottom:1.1rem;z-index:60;width:max-content;margin:1.6rem auto 0;
  display:flex;align-items:center;gap:.1rem;padding:.3rem .4rem;border-radius:999px;white-space:nowrap;
  font-family:ui-monospace,Menlo,monospace;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);
  background:color-mix(in srgb, var(--panel) 68%, transparent);
  border:1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  box-shadow:0 14px 38px rgba(0,0,0,.28), inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
  -webkit-backdrop-filter:blur(20px) saturate(1.7);backdrop-filter:blur(20px) saturate(1.7)}
.mm .csort>span{margin:0 .55rem 0 .6rem}
.mm .csb{background:none;border:0;padding:.4rem .8rem;border-radius:999px;font:inherit;letter-spacing:inherit;text-transform:uppercase;color:var(--ink3);cursor:pointer;transition:color .15s}
.mm .csb:hover{color:var(--ink2)}
.mm .csb.on{color:var(--accent);font-weight:700;
  background:color-mix(in srgb, var(--ink) 9%, transparent);
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent), 0 1px 3px rgba(0,0,0,.14)}
.mm .cdom{margin:0 0 1.4rem;background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:1rem 1.2rem;box-shadow:var(--shadowcard);
  display:flex;flex-direction:column}
/* The rows arrive inside the renderer's own wrapper element; display:contents
   lifts them out of it so each row is a flex item of .cdom and can be ordered. */
.mm .cdom > span{display:contents}
.mm .cdom h3{order:-2}
.mm .cdom .cstrip{order:-1}
.mm .crow{order:9}
/* the layer sort — kept in step with LAYER_ORDER by ordering.test.ts */
.mm .by-layer .crow.lr-edge{order:0}
.mm .by-layer .crow.lr-shell{order:1}
.mm .by-layer .crow.lr-mix{order:2}
.mm .by-layer .crow.lr-core{order:3}
.mm .cdom h3{margin:0;font-size:1.02rem;font-weight:740;display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap}
.mm .cdom h3 .cflagn{font-family:ui-monospace,Menlo,monospace;font-size:.68rem;color:var(--accent);font-weight:600}
.mm .cstrip{display:flex;height:6px;border-radius:4px;overflow:hidden;margin:.5rem 0 .85rem;background:var(--panel2)}
.mm .cstrip i{height:100%;display:block}
.mm .crow{display:grid;grid-template-columns:1fr auto auto 16px;gap:.3rem .9rem;align-items:baseline;padding:.34rem .1rem;border-bottom:1px solid var(--hair2);font-size:.9rem}
.mm .crow:last-child{border-bottom:0}
.mm .crow .cname{color:var(--ink)}
.mm .clayer{font-family:ui-monospace,Menlo,monospace;font-size:.64rem;letter-spacing:.08em;text-transform:uppercase;font-weight:600;justify-self:end}
.mm .clayer.l-core{color:var(--core)} .mm .clayer.l-shell{color:var(--shell)} .mm .clayer.l-edge{color:var(--edge)} .mm .clayer.l-mix{color:var(--ink3)}
.mm .cstat{font-family:ui-monospace,Menlo,monospace;font-size:.62rem;letter-spacing:.06em;text-transform:uppercase;padding:.08rem .45rem;border-radius:5px;justify-self:end}
.mm .s-live{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
.mm .s-partial{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.mm .s-latent,.mm .s-stranded{background:color-mix(in srgb,var(--ink3) 16%,transparent);color:var(--ink3)}
.mm .s-absent{border:1px dashed var(--hair);color:var(--ink3)}
.mm .cflag{color:var(--accent);font-weight:700;text-align:center;cursor:help}
.mm .cband{display:flex;align-items:baseline;gap:.75rem;margin:2.1rem 0 1rem;padding-bottom:.45rem;border-bottom:2px solid var(--bt)}
.mm .cband .cbt{font-size:1.15rem;font-weight:780;letter-spacing:-.01em;color:var(--ink)}
.mm .cband .cbs{font-family:ui-monospace,Menlo,monospace;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:var(--bt);font-weight:600}
.mm .cband.l-shell{--bt:var(--shell)} .mm .cband.l-edge{--bt:var(--edge)} .mm .cband.l-core{--bt:var(--core)}

/* Open questions is a filter as well as a sort: only flagged rows and the
   containers that still hold one survive, and the maturity strips go with them
   because they describe a distribution the filtered rows no longer represent. */
.mm .flags-only .crow:not(.flagged){display:none}
.mm .flags-only .cdom:not(.flagged){display:none}
.mm .flags-only .cband:not(.flagged){display:none}
.mm .flags-only .cstrip{display:none}
.mm .flags-only .crow.flagged:last-of-type{border-bottom:0}

/* tooltips: the source note still applies, a native title does not render here.
   Rows carry data-tip unconditionally so the reactive JSX stays branch-free, so
   the empty case has to be excluded here or bare rows sprout an empty bubble. */
.mm [data-tip]:not([data-tip=""]){position:relative;cursor:help}
.mm [data-tip]:not([data-tip=""]):hover::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 7px);z-index:70;
  width:max-content;max-width:min(52ch,74vw);white-space:normal;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  font-size:.8rem;line-height:1.5;font-weight:450;letter-spacing:0;text-transform:none;text-align:left;
  background:var(--ink);color:var(--bg);padding:.55rem .75rem;border-radius:8px;box-shadow:var(--shadowcard)}
.mm .cflag[data-tip]:not([data-tip=""]):hover::after{left:auto;right:0}

/* claims */
.mm .claims-intro{margin:0 0 1.4rem;max-width:74ch}
.mm .claims-intro .ci-h{font-size:1.35rem;font-weight:750;letter-spacing:-.02em;margin:0 0 .35rem}
.mm .claims-intro p{color:var(--ink3);font-size:1rem;margin:0 0 .75rem}
.mm .claims-intro p:last-child{margin-bottom:0}
.mm .claim{border:0}
.mm .claim>summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:.55rem;padding:1.35rem 0 .2rem}
.mm .claim>summary::-webkit-details-marker{display:none}
.mm .claim>summary::before{content:"\\203A";color:var(--ink3);font-size:1.5rem;line-height:1;transform:translateY(1px);transition:transform .15s ease;flex:none}
.mm .claim[open]>summary::before{transform:translateY(1px) rotate(90deg)}
.mm .claim>summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
.mm .claim .cname{font-size:1.7rem;font-weight:800;letter-spacing:-.025em;color:var(--ink);line-height:1.1}
.mm .claim .ctag{font-size:1.28rem;font-weight:340;color:var(--ink3);letter-spacing:-.01em}
.mm .claim .ctag i{font-style:italic}
.mm .claim-body{padding:.15rem 0 1.7rem 2rem;max-width:82ch}
.mm .claim-lede{font-size:1.18rem;line-height:1.5;color:var(--ink);font-weight:340;margin:.45rem 0 1.25rem}
.mm .cblock{display:grid;grid-template-columns:auto 1fr;column-gap:.7rem;align-items:baseline;margin:.9rem 0 .9rem 1.4rem;font-size:1.02rem;line-height:1.62;color:var(--ink2)}
.mm .cblock .bl{font-family:ui-monospace,Menlo,monospace;font-size:.68rem;letter-spacing:.11em;text-transform:uppercase;font-weight:700;white-space:nowrap}
.mm .cblock .bl.benefit{color:var(--shell)} .mm .cblock .bl.villain{color:var(--crit)} .mm .cblock .bl.mech{color:var(--core)}
.mm .cblock b{color:var(--ink);font-weight:620}

/* map figure */
.mm .fmap{margin:2.4rem 0 0;max-width:76ch}
.mm .fmap img{display:block;width:100%;border-radius:14px;border:1px solid var(--hair);box-shadow:var(--shadowcard)}
.mm .fmap figcaption{margin:.8rem .2rem 0;font-size:.86rem;line-height:1.55;color:var(--ink3)}

/* close */
.mm .close{background:var(--panel);border:1px solid var(--hair);border-radius:14px;padding:1.4rem 1.5rem;box-shadow:var(--shadowcard)}
.mm footer{color:var(--ink3);font-family:ui-monospace,Menlo,monospace;font-size:.71rem;line-height:1.6;max-width:80ch}

@media (max-width:720px){
  .mm .lhead{grid-template-columns:1fr}
  .mm .stackwrap{grid-template-columns:1fr} .mm .vrail{display:none}
}
@media (max-width:640px){
  .mm .crow{grid-template-columns:1fr auto auto 14px;font-size:.86rem}
  .mm .tier{grid-template-columns:1fr;gap:.8rem}
  .mm .csort>span{display:none} .mm .csort{padding-left:.35rem}
  .mm .claim-body{padding-left:0}
  .mm .cblock{grid-template-columns:1fr;row-gap:.2rem;margin-left:0}
}
`;
