/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type CitationStyle = "APA" | "MLA" | "Chicago";

interface CitationInput {
  id?: unknown;
  title?: unknown;
  authors?: unknown;
  topic?: unknown;
  year?: unknown;
  style?: unknown;
  summary?: unknown;
}

interface CitationRecord {
  id: string;
  title: string;
  authors: string[];
  topic: string;
  year: number;
  style: CitationStyle;
  summary: string;
}

interface CitationArgs {
  citations: Default<CitationInput[], []>;
  style: Default<CitationStyle | string, "APA">;
}

interface BibliographyGroups {
  byTopic: Record<string, CitationRecord[]>;
  byStyle: Record<string, CitationRecord[]>;
}

interface BibliographySnapshot {
  total: number;
  topics: number;
  styles: number;
  activeStyle: CitationStyle;
  activeBibliography: string[];
  headline: string;
}

interface AddCitationEvent {
  id?: unknown;
  title?: unknown;
  authors?: unknown;
  topic?: unknown;
  year?: unknown;
  style?: unknown;
  summary?: unknown;
}

interface RetagCitationEvent {
  id?: unknown;
  topic?: unknown;
  style?: unknown;
}

const allowedStyles: readonly CitationStyle[] = [
  "APA",
  "MLA",
  "Chicago",
];

const styleOrder = new Map<CitationStyle, number>([
  ["APA", 0],
  ["MLA", 1],
  ["Chicago", 2],
]);

const normalizeStyle = (
  value: unknown,
  fallback: CitationStyle,
): CitationStyle => {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  const style = allowedStyles.find((entry) => entry.toUpperCase() === upper);
  return style ?? fallback;
};

const normalizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const topicLabel = (index: number): string => `Topic ${index}`;

const normalizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const normalizeAuthors = (value: unknown): string[] => {
  if (!Array.isArray(value)) return ["Unknown Author"];
  const authors = value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
  return authors.length > 0 ? authors : ["Unknown Author"];
};

const normalizeYear = (value: unknown, fallbackIndex: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 2000 + fallbackIndex;
  }
  return Math.trunc(value);
};

const generateId = (
  desired: string,
  existing: ReadonlySet<string>,
): string => {
  if (!existing.has(desired)) return desired;
  let suffix = 2;
  while (existing.has(`${desired}-${suffix}`)) {
    suffix++;
  }
  return `${desired}-${suffix}`;
};

const formatSummary = (citation: CitationRecord): string => {
  const authors = citation.authors.join(", ");
  return `${authors} (${citation.year}). ${citation.title}.`;
};

const sanitizeCitation = (
  input: CitationInput,
  fallbackIndex: number,
  fallbackStyle: CitationStyle,
  existing: ReadonlySet<string>,
): CitationRecord => {
  const baseId = normalizeText(
    typeof input?.id === "string" ? input.id : "",
    `citation-${fallbackIndex}`,
  );
  const id = generateId(baseId, existing);
  const title = normalizeText(input?.title, `Untitled ${fallbackIndex}`);
  const authors = normalizeAuthors(input?.authors);
  const topic = normalizeTopic(input?.topic, topicLabel(fallbackIndex));
  const year = normalizeYear(input?.year, fallbackIndex);
  const style = normalizeStyle(input?.style, fallbackStyle);
  const summary = normalizeText(
    input?.summary,
    formatSummary({
      id,
      title,
      authors,
      topic,
      year,
      style,
      summary: "",
    }),
  );

  return { id, title, authors, topic, year, style, summary };
};

const sanitizeCitations = (
  value: readonly CitationInput[] | undefined,
  fallbackStyle: CitationStyle,
): CitationRecord[] => {
  if (!Array.isArray(value)) return [];
  const result: CitationRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] ?? {};
    const record = sanitizeCitation(entry, index + 1, fallbackStyle, seen);
    seen.add(record.id);
    result.push(record);
  }
  return result;
};

const copyCitation = (citation: CitationRecord): CitationRecord => ({
  id: citation.id,
  title: citation.title,
  authors: [...citation.authors],
  topic: citation.topic,
  year: citation.year,
  style: citation.style,
  summary: citation.summary,
});

const sortCitations = (entries: CitationRecord[]): CitationRecord[] => {
  return [...entries].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const topicCompare = a.topic.localeCompare(b.topic);
    if (topicCompare !== 0) return topicCompare;
    return a.title.localeCompare(b.title);
  });
};

const buildGroups = (
  entries: readonly CitationRecord[],
): BibliographyGroups => {
  const byTopic = new Map<string, CitationRecord[]>();
  const byStyle = new Map<string, CitationRecord[]>();

  for (const entry of entries) {
    const topicGroup = byTopic.get(entry.topic) ?? [];
    topicGroup.push(copyCitation(entry));
    byTopic.set(entry.topic, topicGroup);

    const styleGroup = byStyle.get(entry.style) ?? [];
    styleGroup.push(copyCitation(entry));
    byStyle.set(entry.style, styleGroup);
  }

  const topicResult: Record<string, CitationRecord[]> = {};
  const sortedTopics = Array.from(byTopic.keys()).sort((lhs, rhs) =>
    lhs.localeCompare(rhs)
  );
  for (const topic of sortedTopics) {
    topicResult[topic] = sortCitations(byTopic.get(topic) ?? []);
  }

  const styleResult: Record<string, CitationRecord[]> = {};
  const sortedStyles = Array.from(byStyle.keys()).sort((lhs, rhs) => {
    const leftOrder = styleOrder.get(lhs as CitationStyle) ??
      Number.MAX_SAFE_INTEGER;
    const rightOrder = styleOrder.get(rhs as CitationStyle) ??
      Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return lhs.localeCompare(rhs);
  });
  for (const style of sortedStyles) {
    styleResult[style] = sortCitations(byStyle.get(style) ?? []);
  }

  return { byTopic: topicResult, byStyle: styleResult };
};

const formatBibliography = (
  entries: readonly CitationRecord[],
): string[] => {
  return entries.map((entry) => {
    const authors = entry.authors.join(", ");
    return `${authors} (${entry.year}). ${entry.title} — ${entry.topic}. [${entry.style}]`;
  });
};

const toInputList = (
  entries: readonly CitationRecord[],
): CitationInput[] =>
  entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    authors: [...entry.authors],
    topic: entry.topic,
    year: entry.year,
    style: entry.style,
    summary: entry.summary,
  }));

const addCitationHandler = handler(
  (
    _event: unknown,
    context: {
      argument: Cell<CitationInput[]>;
      style: Cell<CitationStyle | string>;
      titleField: Cell<string>;
      authorsField: Cell<string>;
      topicField: Cell<string>;
      yearField: Cell<string>;
      styleField: Cell<string>;
    },
  ) => {
    const fallbackStyle = normalizeStyle(context.style.get(), "APA");
    const current = sanitizeCitations(context.argument.get(), fallbackStyle);
    const nextIndex = current.length + 1;
    const seen = new Set(current.map((entry) => entry.id));

    const titleVal = context.titleField.get();
    const authorsVal = context.authorsField.get();
    const topicVal = context.topicField.get();
    const yearVal = context.yearField.get();
    const styleVal = context.styleField.get();

    const authorsArray = typeof authorsVal === "string"
      ? authorsVal.split(",").map((a) => a.trim()).filter((a) => a.length > 0)
      : [];

    const yearNum = typeof yearVal === "string" ? parseInt(yearVal, 10) : NaN;

    const record = sanitizeCitation(
      {
        title: titleVal,
        authors: authorsArray,
        topic: topicVal,
        year: Number.isFinite(yearNum) ? yearNum : undefined,
        style: styleVal,
      },
      nextIndex,
      fallbackStyle,
      seen,
    );
    const nextCatalog = [...current, record];
    context.argument.set(toInputList(nextCatalog));

    // Clear form fields
    context.titleField.set("");
    context.authorsField.set("");
    context.topicField.set("");
    context.yearField.set("");
    context.styleField.set("");
  },
);

const retagCitationHandler = handler(
  (
    _event: unknown,
    context: {
      argument: Cell<CitationInput[]>;
      style: Cell<CitationStyle | string>;
      idField: Cell<string>;
      newTopicField: Cell<string>;
      newStyleField: Cell<string>;
    },
  ) => {
    const targetId = context.idField.get();
    if (typeof targetId !== "string" || targetId.trim() === "") return;

    const fallbackStyle = normalizeStyle(context.style.get(), "APA");
    const list = sanitizeCitations(context.argument.get(), fallbackStyle);
    const next = list.map((entry) => {
      if (entry.id !== targetId) return entry;

      const newTopicVal = context.newTopicField.get();
      const newStyleVal = context.newStyleField.get();

      const nextTopic = typeof newTopicVal === "string" &&
          newTopicVal.trim() !== ""
        ? newTopicVal
        : entry.topic;
      const nextStyle = typeof newStyleVal === "string" &&
          newStyleVal.trim() !== ""
        ? normalizeStyle(newStyleVal, entry.style)
        : entry.style;

      const updated: CitationRecord = {
        ...entry,
        topic: nextTopic,
        style: nextStyle,
      };
      return { ...updated, summary: formatSummary(updated) };
    });
    context.argument.set(toInputList(next));

    // Clear form fields
    context.idField.set("");
    context.newTopicField.set("");
    context.newStyleField.set("");
  },
);

const updateActiveStyleHandler = handler(
  (
    _event: unknown,
    context: {
      style: Cell<CitationStyle | string>;
      styleFilterField: Cell<string>;
    },
  ) => {
    const requested = context.styleFilterField.get();
    if (typeof requested === "string" && requested.trim() !== "") {
      const sanitized = normalizeStyle(requested, "APA");
      context.style.set(sanitized);
      context.styleFilterField.set("");
    }
  },
);

export const researchCitationManagerUx = recipe<CitationArgs>(
  "Research Citation Manager (UX)",
  ({ citations, style }) => {
    const activeStyle = lift((value: CitationStyle | string | undefined) =>
      normalizeStyle(value, "APA")
    )(style);

    const citationCatalog = lift<
      { entries: Cell<CitationInput[]>; fallback: Cell<CitationStyle> },
      CitationRecord[]
    >(
      ({ entries, fallback }) =>
        sanitizeCitations(entries.get(), fallback.get()),
    )({ entries: citations, fallback: activeStyle });

    const groups = lift<
      { entries: Cell<CitationRecord[]> },
      BibliographyGroups
    >(
      ({ entries }) => buildGroups(entries.get() ?? []),
    )({ entries: citationCatalog });

    const groupedByTopic = lift((g: BibliographyGroups) => g.byTopic)(groups);
    const groupedByStyle = lift((g: BibliographyGroups) => g.byStyle)(groups);

    const topicBibliographies = lift((
      mapping: Record<string, CitationRecord[]>,
    ) => {
      const labels: Record<string, string[]> = {};
      for (const key of Object.keys(mapping)) {
        labels[key] = formatBibliography(mapping[key]);
      }
      return labels;
    })(groupedByTopic);

    const styleBibliographies = lift((
      mapping: Record<string, CitationRecord[]>,
    ) => {
      const labels: Record<string, string[]> = {};
      for (const key of Object.keys(mapping)) {
        labels[key] = formatBibliography(mapping[key]);
      }
      return labels;
    })(groupedByStyle);

    const activeBibliography = lift<
      { style: Cell<CitationStyle>; catalog: Cell<Record<string, string[]>> },
      string[]
    >(
      ({ style: active, catalog }) => {
        const current = active.get();
        const mapping = catalog.get() ?? {};
        return mapping[current] ?? [];
      },
    )({ style: activeStyle, catalog: styleBibliographies });

    const snapshot = lift<
      {
        entries: Cell<CitationRecord[]>;
        topics: Cell<Record<string, CitationRecord[]>>;
        styles: Cell<Record<string, CitationRecord[]>>;
        active: Cell<CitationStyle>;
        bibliography: Cell<string[]>;
      },
      BibliographySnapshot
    >(
      ({ entries, topics, styles, active, bibliography }) => {
        const catalog = entries.get() ?? [];
        const topicKeys = Object.keys(topics.get() ?? {});
        const styleKeys = Object.keys(styles.get() ?? {});
        const activeStyleValue = active.get();
        const headline =
          `${catalog.length} citations across ${topicKeys.length} topics using ${styleKeys.length} styles.`;
        return {
          total: catalog.length,
          topics: topicKeys.length,
          styles: styleKeys.length,
          activeStyle: activeStyleValue,
          activeBibliography: bibliography.get() ?? [],
          headline,
        };
      },
    )({
      entries: citationCatalog,
      topics: groupedByTopic,
      styles: groupedByStyle,
      active: activeStyle,
      bibliography: activeBibliography,
    });

    const summary = str`${snapshot.key("total")} citations in ${
      snapshot.key("topics")
    } topics with ${snapshot.key("styles")} styles (active ${activeStyle}).`;

    // UI form fields
    const titleField = cell("");
    const authorsField = cell("");
    const topicField = cell("");
    const yearField = cell("");
    const styleField = cell("");
    const idField = cell("");
    const newTopicField = cell("");
    const newStyleField = cell("");
    const styleFilterField = cell("");

    const addCitation = addCitationHandler({
      argument: citations,
      style,
      titleField,
      authorsField,
      topicField,
      yearField,
      styleField,
    });

    const retagCitation = retagCitationHandler({
      argument: citations,
      style,
      idField,
      newTopicField,
      newStyleField,
    });

    const setStyle = updateActiveStyleHandler({ style, styleFilterField });

    const name = str`Citations: ${snapshot.key("total")}`;

    const totalCount = lift((s: BibliographySnapshot) => s.total)(snapshot);
    const topicsCount = lift((s: BibliographySnapshot) => s.topics)(snapshot);
    const stylesCount = lift((s: BibliographySnapshot) => s.styles)(snapshot);
    const headline = lift((s: BibliographySnapshot) => s.headline)(snapshot);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Research Citation Manager
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Organize and format academic citations
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #dbeafe, #bfdbfe);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  gap: 1.5rem;
                  align-items: center;
                  justify-content: space-around;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 2rem;
                      font-weight: 700;
                      color: #1e40af;
                      font-family: monospace;
                    ">
                    {totalCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: #1e3a8a;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Citations
                  </span>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 2rem;
                      font-weight: 700;
                      color: #1e40af;
                      font-family: monospace;
                    ">
                    {topicsCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: #1e3a8a;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Topics
                  </span>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 2rem;
                      font-weight: 700;
                      color: #1e40af;
                      font-family: monospace;
                    ">
                    {stylesCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: #1e3a8a;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Styles
                  </span>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.875rem;
                  color: #334155;
                  text-align: center;
                ">
                {headline}
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #0f172a;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  font-weight: 600;
                ">
                Add Citation
              </h3>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Title
                  </label>
                  <ct-input
                    $value={titleField}
                    placeholder="Paper title"
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Authors (comma-separated)
                  </label>
                  <ct-input
                    $value={authorsField}
                    placeholder="Smith, J., Doe, A."
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Topic
                  </label>
                  <ct-input
                    $value={topicField}
                    placeholder="Research topic"
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Year
                  </label>
                  <ct-input
                    $value={yearField}
                    placeholder="2024"
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Citation Style
                  </label>
                  <ct-input
                    $value={styleField}
                    placeholder="APA, MLA, or Chicago"
                  />
                </div>
              </div>

              <ct-button onClick={addCitation} aria-label="Add citation">
                Add Citation
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #0f172a;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  font-weight: 600;
                ">
                Retag Citation
              </h3>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr 1fr;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Citation ID
                  </label>
                  <ct-input
                    $value={idField}
                    placeholder="citation-1"
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    New Topic
                  </label>
                  <ct-input
                    $value={newTopicField}
                    placeholder="New topic"
                  />
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    New Style
                  </label>
                  <ct-input
                    $value={newStyleField}
                    placeholder="APA, MLA, Chicago"
                  />
                </div>
              </div>

              <ct-button onClick={retagCitation} aria-label="Retag citation">
                Update Citation
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #0f172a;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  font-weight: 600;
                ">
                Filter by Style
              </h3>

              <div style="
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <span style="
                    font-size: 0.875rem;
                    color: #475569;
                    font-weight: 500;
                  ">
                  Active Style:
                </span>
                <span style="
                    padding: 0.25rem 0.75rem;
                    background: #dbeafe;
                    color: #1e40af;
                    border-radius: 0.375rem;
                    font-weight: 600;
                    font-size: 0.875rem;
                  ">
                  {activeStyle}
                </span>
              </div>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  align-items: flex-end;
                ">
                <div style="
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <label style="
                      font-size: 0.75rem;
                      color: #475569;
                      font-weight: 500;
                    ">
                    Change Style Filter
                  </label>
                  <ct-input
                    $value={styleFilterField}
                    placeholder="APA, MLA, or Chicago"
                  />
                </div>
                <ct-button onClick={setStyle} aria-label="Change style filter">
                  Apply
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #0f172a;
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  font-weight: 600;
                ">
                Bibliography ({activeStyle})
              </h3>

              {lift((bib: string[]) => {
                if (!bib || bib.length === 0) {
                  return h(
                    "div",
                    {
                      style:
                        "padding: 2rem; text-align: center; color: #94a3b8; font-style: italic;",
                    },
                    "No citations available for this style",
                  );
                }

                const elements = [];
                for (const entry of bib) {
                  elements.push(
                    h(
                      "div",
                      {
                        style:
                          "padding: 0.75rem; background: #f8fafc; border-left: 3px solid #3b82f6; border-radius: 0.25rem; font-size: 0.875rem; color: #334155; line-height: 1.5;",
                      },
                      entry,
                    ),
                  );
                }

                return h(
                  "div",
                  {
                    style:
                      "display: flex; flex-direction: column; gap: 0.5rem;",
                  },
                  ...elements,
                );
              })(activeBibliography)}
            </div>
          </ct-card>

          {lift((catalog: CitationRecord[]) => {
            if (!catalog || catalog.length === 0) {
              return null;
            }

            const elements = [];
            for (const citation of catalog) {
              const authorsStr = citation.authors.join(", ");

              elements.push(
                h(
                  "ct-card",
                  {},
                  h(
                    "div",
                    {
                      slot: "content",
                      style:
                        "display: flex; flex-direction: column; gap: 0.5rem;",
                    },
                    h(
                      "div",
                      {
                        style:
                          "display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;",
                      },
                      h(
                        "div",
                        { style: "flex: 1;" },
                        h(
                          "div",
                          {
                            style:
                              "font-weight: 600; color: #0f172a; font-size: 0.9rem; margin-bottom: 0.25rem;",
                          },
                          citation.title,
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.8rem; color: #64748b; margin-bottom: 0.25rem;",
                          },
                          authorsStr,
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.75rem; color: #94a3b8; font-style: italic;",
                          },
                          citation.summary,
                        ),
                      ),
                      h(
                        "div",
                        {
                          style:
                            "display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-end;",
                        },
                        h(
                          "span",
                          {
                            style:
                              "padding: 0.15rem 0.5rem; background: #f1f5f9; color: #475569; border-radius: 0.25rem; font-size: 0.7rem; font-weight: 500; font-family: monospace;",
                          },
                          citation.id,
                        ),
                        h(
                          "span",
                          {
                            style:
                              "padding: 0.15rem 0.5rem; background: #dbeafe; color: #1e40af; border-radius: 0.25rem; font-size: 0.7rem; font-weight: 600;",
                          },
                          citation.style,
                        ),
                      ),
                    ),
                    h(
                      "div",
                      {
                        style:
                          "display: flex; justify-content: space-between; padding-top: 0.5rem; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b;",
                      },
                      h(
                        "span",
                        {},
                        h("strong", {}, "Topic: "),
                        citation.topic,
                      ),
                      h(
                        "span",
                        {},
                        h("strong", {}, "Year: "),
                        String(citation.year),
                      ),
                    ),
                  ),
                ),
              );
            }

            return h(
              "div",
              { style: "display: flex; flex-direction: column; gap: 0.75rem;" },
              h(
                "h3",
                {
                  style:
                    "margin: 0; font-size: 1rem; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;",
                },
                "All Citations",
              ),
              ...elements,
            );
          })(citationCatalog)}

          <div style="
              background: #f8fafc;
              border-radius: 0.5rem;
              padding: 1rem;
              font-size: 0.85rem;
              color: #475569;
              line-height: 1.5;
            ">
            <strong>Pattern:</strong>{" "}
            This demonstrates managing academic citations with multiple grouping
            strategies. Add citations with author, title, topic, year, and
            citation style. The system automatically generates formatted
            bibliographies filtered by style (APA, MLA, Chicago) and groups
            citations by topic. Retag existing citations to reorganize your
            research library.
          </div>
        </div>
      ),
      citations: citationCatalog,
      groupedByTopic,
      groupedByStyle,
      topicBibliographies,
      styleBibliographies,
      activeStyle,
      activeBibliography,
      snapshot,
      summary,
      controls: {
        addCitation,
        retagCitation,
        setStyle,
      },
    };
  },
);

export default researchCitationManagerUx;
