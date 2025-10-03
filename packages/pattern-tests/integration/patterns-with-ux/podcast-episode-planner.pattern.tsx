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

interface EpisodeSegmentInput {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
}

interface EpisodeSegment {
  id: string;
  title: string;
  duration: number;
}

interface PodcastEpisodePlannerArgs {
  segments: Default<EpisodeSegmentInput[], typeof defaultSegments>;
}

interface OutlineEntry extends EpisodeSegment {
  startMinute: number;
  endMinute: number;
  label: string;
}

const defaultSegments: EpisodeSegment[] = [
  { id: "intro", title: "Intro", duration: 2 },
  { id: "interview", title: "Interview", duration: 25 },
  { id: "outro", title: "Outro", duration: 3 },
];

const sanitizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "");
};

const slugFromTitle = (title: string): string => {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return normalized.length > 0 ? normalized : "segment";
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded > 0 ? rounded : 1;
  }
  return 5;
};

const sanitizeSegments = (
  input: readonly EpisodeSegmentInput[] | undefined,
): EpisodeSegment[] => {
  const base = Array.isArray(input) && input.length > 0
    ? input
    : defaultSegments;
  const seen = new Set<string>();
  const sanitized: EpisodeSegment[] = [];
  let index = 0;
  for (const entry of base) {
    const fallbackTitle = `Segment ${index + 1}`;
    const rawTitle = (entry as EpisodeSegmentInput)?.title;
    const title = sanitizeTitle(rawTitle, fallbackTitle);
    const rawId = (entry as EpisodeSegmentInput)?.id;
    const candidate = sanitizeId(rawId) ?? slugFromTitle(title);
    const baseId = candidate.length > 0 ? candidate : `segment-${index + 1}`;
    let id = baseId;
    let suffix = 1;
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    const rawDuration = (entry as EpisodeSegmentInput)?.duration;
    const duration = sanitizeDuration(rawDuration);
    sanitized.push({ id, title, duration });
    index += 1;
  }
  if (sanitized.length === 0) {
    return defaultSegments.map((segment) => ({ ...segment }));
  }
  return sanitized;
};

const ensureSegments = (
  segments: Cell<EpisodeSegmentInput[]>,
): EpisodeSegment[] => {
  const raw = segments.get();
  const sanitized = sanitizeSegments(raw);
  if (
    !Array.isArray(raw) ||
    raw.length !== sanitized.length ||
    sanitized.some((segment, idx) => {
      const current = raw?.[idx] as EpisodeSegmentInput | undefined;
      if (!current) return true;
      const normalizedTitle = sanitizeTitle(current.title, segment.title);
      const normalizedDuration = sanitizeDuration(current.duration);
      return current.id !== segment.id ||
        normalizedTitle !== segment.title ||
        normalizedDuration !== segment.duration;
    })
  ) {
    segments.set(sanitized.map((segment) => ({ ...segment })));
  }
  return sanitized;
};

const clampIndex = (value: unknown, length: number): number => {
  if (length <= 1) return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    const index = Math.trunc(value);
    if (index < 0) return 0;
    if (index >= length) return length - 1;
    return index;
  }
  return 0;
};

const updateSegmentDetailsHandler = handler(
  (
    _event: unknown,
    context: {
      segments: Cell<EpisodeSegmentInput[]>;
      segmentIdField: Cell<string>;
      segmentTitleField: Cell<string>;
      segmentDurationField: Cell<string>;
    },
  ) => {
    const segments = ensureSegments(context.segments);
    const identifier = sanitizeId(context.segmentIdField.get());
    if (!identifier) return;
    const index = segments.findIndex((segment) => segment.id === identifier);
    if (index < 0) return;
    const current = segments[index];

    const titleValue = context.segmentTitleField.get();
    const durationValue = context.segmentDurationField.get();

    const nextTitle = sanitizeTitle(titleValue, current.title);
    const nextDuration = sanitizeDuration(Number(durationValue));

    if (nextTitle === current.title && nextDuration === current.duration) {
      return;
    }
    const next = segments.slice();
    next[index] = { ...current, title: nextTitle, duration: nextDuration };
    context.segments.set(next);

    // Clear form fields
    context.segmentIdField.set("");
    context.segmentTitleField.set("");
    context.segmentDurationField.set("5");
  },
);

const reorderSegmentsHandler = handler(
  (
    _event: unknown,
    context: {
      segments: Cell<EpisodeSegmentInput[]>;
      fromIndexField: Cell<string>;
      toIndexField: Cell<string>;
    },
  ) => {
    const segments = ensureSegments(context.segments);
    if (segments.length < 2) return;
    const fromIndex = clampIndex(
      Number(context.fromIndexField.get()),
      segments.length,
    );
    const toIndex = clampIndex(
      Number(context.toIndexField.get()),
      segments.length,
    );
    if (fromIndex === toIndex) return;
    const next = segments.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    context.segments.set(next);
  },
);

const buildTimeline = (segments: readonly EpisodeSegment[]): OutlineEntry[] => {
  const entries: OutlineEntry[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const startMinute = cursor;
    const endMinute = cursor + segment.duration;
    entries.push({
      ...segment,
      startMinute,
      endMinute,
      label:
        `${segment.title} (${segment.duration}m) @${startMinute}-${endMinute}`,
    });
    cursor = endMinute;
  }
  return entries;
};

/** Pattern orchestrating podcast episode segments into a timed outline. */
export const podcastEpisodePlannerUx = recipe<PodcastEpisodePlannerArgs>(
  "Podcast Episode Planner (UX)",
  ({ segments }) => {
    const segmentsView = lift(
      (value: EpisodeSegmentInput[] | undefined): EpisodeSegment[] =>
        sanitizeSegments(value),
    )(segments);

    const timeline = lift(
      (entries: EpisodeSegment[] | undefined): OutlineEntry[] =>
        buildTimeline(Array.isArray(entries) ? entries : []),
    )(segmentsView);

    const outline = lift(
      (entries: OutlineEntry[] | undefined): string => {
        if (!entries || entries.length === 0) return "(empty outline)";
        return entries.map((entry) => entry.label).join(" -> ");
      },
    )(timeline);

    const totalMinutes = lift(
      (entries: OutlineEntry[] | undefined): number => {
        if (!entries || entries.length === 0) return 0;
        return entries[entries.length - 1].endMinute;
      },
    )(timeline);

    // UI form fields
    const segmentIdField = cell<string>("");
    const segmentTitleField = cell<string>("");
    const segmentDurationField = cell<string>("5");
    const fromIndexField = cell<string>("0");
    const toIndexField = cell<string>("1");

    const updateSegment = updateSegmentDetailsHandler({
      segments,
      segmentIdField,
      segmentTitleField,
      segmentDurationField,
    });

    const reorderSegments = reorderSegmentsHandler({
      segments,
      fromIndexField,
      toIndexField,
    });

    const name = str`Podcast Episode Planner (${totalMinutes}m)`;

    const timelineVisualization = lift((entries: OutlineEntry[]) => {
      if (!entries || entries.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.9rem;
            ">
            No segments added yet.
          </div>
        );
      }

      const elements = [];
      const total = entries[entries.length - 1]?.endMinute || 1;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const widthPercent = (entry.duration / total) * 100;
        const bgColor = i % 3 === 0
          ? "#dbeafe"
          : (i % 3 === 1 ? "#e0e7ff" : "#fce7f3");
        const borderColor = i % 3 === 0
          ? "#3b82f6"
          : (i % 3 === 1 ? "#6366f1" : "#ec4899");

        elements.push(
          <div
            key={String(i)}
            style={"flex: " + String(entry.duration) + "; background: " +
              bgColor + "; border: 2px solid " + borderColor +
              "; border-radius: 0.5rem; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; min-width: 80px;"}
          >
            <div style="font-weight: 600; font-size: 0.95rem; color: #0f172a;">
              {entry.title}
            </div>
            <div style="font-size: 0.75rem; color: #64748b; font-family: monospace;">
              {String(entry.duration)}m
            </div>
            <div style="font-size: 0.7rem; color: #94a3b8; font-family: monospace;">
              @{String(entry.startMinute)}-{String(entry.endMinute)}
            </div>
          </div>,
        );
      }

      return (
        <div style="display: flex; gap: 0.5rem; width: 100%; overflow-x: auto;">
          {elements}
        </div>
      );
    })(timeline);

    const segmentsList = lift((segs: EpisodeSegment[]) => {
      if (!segs || segs.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.9rem;
            ">
            No segments to display.
          </div>
        );
      }

      const elements = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const bgColor = i % 2 === 0 ? "#f8fafc" : "#ffffff";

        elements.push(
          <div
            key={String(i)}
            style={"display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1rem; background: " +
              bgColor + "; border-bottom: 1px solid #e2e8f0;"}
          >
            <span style="font-size: 0.75rem; color: #64748b; min-width: 1.5rem; text-align: center; font-family: monospace;">
              {String(i)}
            </span>
            <div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
              <span style="font-weight: 600; color: #0f172a; font-size: 0.95rem;">
                {seg.title}
              </span>
              <span style="font-size: 0.75rem; color: #64748b; font-family: monospace;">
                ID: {seg.id}
              </span>
            </div>
            <span style="background: #e0e7ff; color: #4338ca; padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.85rem; font-weight: 600; font-family: monospace;">
              {String(seg.duration)}m
            </span>
          </div>,
        );
      }

      return (
        <div style="border-radius: 0.5rem; overflow: hidden;">{elements}</div>
      );
    })(segmentsView);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 50rem;
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
                  Podcast Episode Planner
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Plan and organize episode segments with timed timeline
                </h2>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 4px solid #0ea5e9;
                  padding: 1rem;
                  border-radius: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.85rem; color: #0369a1;">
                    Total episode duration
                  </span>
                  <strong style="font-size: 1.75rem; color: #0c4a6e;">
                    {totalMinutes}m
                  </strong>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Episode Timeline
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0;
              "
            >
              {timelineVisualization}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Segments
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0;
              "
            >
              {segmentsList}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Update Segment
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 2fr 1fr;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="segment-id"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Segment ID
                  </label>
                  <ct-input
                    id="segment-id"
                    type="text"
                    placeholder="e.g. intro"
                    $value={segmentIdField}
                    aria-label="Segment ID to update"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="segment-title"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    New Title
                  </label>
                  <ct-input
                    id="segment-title"
                    type="text"
                    placeholder="Enter new title"
                    $value={segmentTitleField}
                    aria-label="New segment title"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="segment-duration"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Duration (min)
                  </label>
                  <ct-input
                    id="segment-duration"
                    type="number"
                    step="1"
                    min="1"
                    $value={segmentDurationField}
                    aria-label="New segment duration in minutes"
                  >
                  </ct-input>
                </div>
              </div>
              <ct-button
                onClick={updateSegment}
                aria-label="Update segment details"
              >
                Update Segment
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Reorder Segments
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="from-index"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    From Index
                  </label>
                  <ct-input
                    id="from-index"
                    type="number"
                    step="1"
                    min="0"
                    $value={fromIndexField}
                    aria-label="Source index for reordering"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="to-index"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    To Index
                  </label>
                  <ct-input
                    id="to-index"
                    type="number"
                    step="1"
                    min="0"
                    $value={toIndexField}
                    aria-label="Target index for reordering"
                  >
                  </ct-input>
                </div>
              </div>
              <ct-button
                variant="secondary"
                onClick={reorderSegments}
                aria-label="Reorder segments"
              >
                Reorder Segments
              </ct-button>
            </div>
          </ct-card>
        </div>
      ),
      segments,
      segmentsView,
      timeline,
      outline,
      totalMinutes,
      label: str`Episode Outline: ${outline}`,
      controls: {
        updateSegment,
        reorderSegments,
      },
    };
  },
);

export default podcastEpisodePlannerUx;
