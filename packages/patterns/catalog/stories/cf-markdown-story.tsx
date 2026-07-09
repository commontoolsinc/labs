import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface MarkdownStoryInput {}
export interface MarkdownStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<MarkdownStoryInput, MarkdownStoryOutput>(() => {
  const content = `## Markdown Rendering

This component renders **bold**, *italic*, and \`inline code\`.

- Bullet lists
- With multiple items

\`\`\`js
const greeting = "Hello from cf-markdown";
console.log(greeting);
\`\`\`

> Blockquotes are supported too.`;

  // A wide table used to verify horizontal-scroll behaviour on narrow
  // (mobile) screens. It has more columns than fit in ~480px, so before the
  // scroll-wrapper fix the columns crammed and text wrapped illegibly; after
  // it, the table keeps a readable per-column minimum width and the block
  // scrolls sideways instead.
  const wideTable = `## Wide table (mobile scroll check)

| Airport | Flights | Terminal | Lodging | Check-in | Notes |
| --- | --- | --- | --- | --- | --- |
| Haneda (HND) | ANA 857 departs 10:45 | Terminal 1 North Wing | Studio AOI 102 | Fri Jul 10 at 16:00 | Arrive early, expect queues at security |
| Narita (NRT) | JAL 004 departs 17:20 | Terminal 2 South | The Tokyo Station Hotel | Sat Jul 11 at 15:00 | Skyliner is fastest into the city |`;

  return {
    [NAME]: "cf-markdown Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "480px" }}>
        <cf-markdown content={content} />
        <cf-markdown content={wideTable} />

        {/* Reproduce the Mobile Loom ancestry: a fixed-width column that lays
            its children out with flex-start (so the host is not stretched) and
            clips horizontal overflow the way cf-screen does. This is the case
            where the host's `min-width: 0` matters — without it the wide table
            would push this column wide and get clipped instead of scrolling. */}
        <div
          style={{
            marginTop: "1.5rem",
            width: "360px",
            border: "1px dashed #9ca3af",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            overflowX: "hidden",
          }}
        >
          <div style={{ fontSize: "12px", color: "#6b7280", padding: "4px 8px" }}>
            360px clipped flex column (Mobile Loom ancestry)
          </div>
          <cf-markdown content={wideTable} />
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: variant (default, inverse),
        streaming, compact.
      </div>
    ),
  };
});
