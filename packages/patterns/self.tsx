/**
 * Self — private self-model data layer.
 *
 * Owns the single, home-local, never-shared record of the user's real self:
 * their values, neurotype assessments, and reflective Q&A responses.
 *
 * This is NOT a profile (outward-facing, many). This is the one private
 * self-model: values, neurotype, and meaning-alignment answers.
 *
 * Usage from other patterns:
 *   const self = wish<SelfOutput>({ query: "#self-model" });
 */
import {
  handler,
  NAME,
  pattern,
  safeDateNow,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ============================================================================
// EXPORTED TYPES (verbatim from CT-1670 spec)
// ============================================================================

export type NeurotypeSystem = "mbti" | "enneagram" | "big5" | "custom";

export interface Neurotype {
  system: NeurotypeSystem;
  result: string; // "INTJ", "5w4"
  detail?: Record<string, number | string>;
  source: "self-reported" | "assessed";
  recordedAt: number;
}

export interface ValueCard {
  title: string;
  description?: string;
  weight?: number;
  sourcePromptId?: string;
}

export interface QAResponse {
  promptId: string;
  prompt: string;
  answer: string;
  track: "meaning" | "neurotype" | "freeform";
  answeredAt: number;
}

export interface SelfModel {
  responses: QAResponse[];
  values: ValueCard[];
  neurotypes: Neurotype[];
}

export const EMPTY_SELF_MODEL: SelfModel = {
  responses: [],
  values: [],
  neurotypes: [],
};

// ============================================================================
// HANDLER EVENT PAYLOAD TYPES
// ============================================================================

export interface RecordNeurotypeEvent {
  system: NeurotypeSystem;
  result: string;
  detail?: Record<string, number | string>;
  source: "self-reported" | "assessed";
}

export interface AddValueCardEvent {
  title: string;
  description?: string;
  weight?: number;
  sourcePromptId?: string;
}

export interface RecordResponseEvent {
  promptId: string;
  prompt: string;
  answer: string;
  track: "meaning" | "neurotype" | "freeform";
}

export interface RemoveNeurotypeEvent {
  system: NeurotypeSystem;
}

export interface RemoveValueCardEvent {
  /** Zero-based index of the ValueCard to remove. */
  index: number;
}

// ============================================================================
// PURE HELPERS (exported — these ARE the shipping mutation logic)
// ============================================================================

/**
 * Upsert a neurotype entry by system.
 * Replaces the entry with the same `system` in-place, or appends if absent.
 */
export function upsertNeurotype(
  model: SelfModel,
  entry: Neurotype,
): SelfModel {
  const idx = model.neurotypes.findIndex((n) => n.system === entry.system);
  if (idx === -1) {
    return { ...model, neurotypes: [...model.neurotypes, entry] };
  }
  return {
    ...model,
    neurotypes: model.neurotypes.map((n, i) => (i === idx ? entry : n)),
  };
}

/** Return a new SelfModel with the ValueCard appended to `values`. */
export function appendValue(model: SelfModel, card: ValueCard): SelfModel {
  return { ...model, values: [...model.values, card] };
}

/** Return a new SelfModel with the QAResponse appended to `responses`. */
export function appendResponse(
  model: SelfModel,
  response: QAResponse,
): SelfModel {
  return { ...model, responses: [...model.responses, response] };
}

/** Return a new SelfModel with the neurotype for `system` removed. No-op if absent. */
export function withoutNeurotype(
  model: SelfModel,
  system: NeurotypeSystem,
): SelfModel {
  return {
    ...model,
    neurotypes: model.neurotypes.filter((n) => n.system !== system),
  };
}

/** Return a new SelfModel with the ValueCard at zero-based `index` removed. */
export function withoutValueAt(model: SelfModel, index: number): SelfModel {
  return {
    ...model,
    values: model.values.filter((_, i) => i !== index),
  };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Upsert a neurotype entry by system.
 * If an entry with the same `system` exists, it is replaced in-place.
 * Otherwise, it is appended.
 */
export const recordNeurotype = handler<
  RecordNeurotypeEvent,
  { selfModel: Writable<SelfModel> }
>(({ system, result, detail, source }, { selfModel }) => {
  const entry: Neurotype = {
    system,
    result,
    detail,
    source,
    recordedAt: safeDateNow(),
  };
  selfModel.set(upsertNeurotype(selfModel.get(), entry));
});

/** Append a ValueCard. */
export const addValueCard = handler<
  AddValueCardEvent,
  { selfModel: Writable<SelfModel> }
>(({ title, description, weight, sourcePromptId }, { selfModel }) => {
  const card: ValueCard = { title, description, weight, sourcePromptId };
  selfModel.set(appendValue(selfModel.get(), card));
});

/** Append a QAResponse. Timestamp is set automatically via safeDateNow(). */
export const recordResponse = handler<
  RecordResponseEvent,
  { selfModel: Writable<SelfModel> }
>(({ promptId, prompt, answer, track }, { selfModel }) => {
  const response: QAResponse = {
    promptId,
    prompt,
    answer,
    track,
    answeredAt: safeDateNow(),
  };
  selfModel.set(appendResponse(selfModel.get(), response));
});

/** Remove the neurotype entry whose system matches. No-op if not found. */
export const removeNeurotype = handler<
  RemoveNeurotypeEvent,
  { selfModel: Writable<SelfModel> }
>(({ system }, { selfModel }) => {
  selfModel.set(withoutNeurotype(selfModel.get(), system));
});

/**
 * Remove a ValueCard by zero-based index.
 * Index-based removal is stable for the current append-only model; when
 * sourcePromptId is populated, callers may prefer to find by that field.
 */
export const removeValueCard = handler<
  RemoveValueCardEvent,
  { selfModel: Writable<SelfModel> }
>(({ index }, { selfModel }) => {
  selfModel.set(withoutValueAt(selfModel.get(), index));
});

// ============================================================================
// PATTERN INPUT / OUTPUT
// ============================================================================

interface SelfInput {
  /**
   * Optional external Writable cell for the self-model.
   * When provided the pattern uses this cell directly (useful for testing
   * and for parent patterns that want to own the storage).
   * When omitted the pattern creates and owns its own durable cell.
   */
  selfModel?: Writable<SelfModel>;
}

/** Private self-model — the user's values, neurotype, and reflective answers. #self-model */
export interface SelfOutput {
  [NAME]: string;
  [UI]: VNode;
  selfModel: Writable<SelfModel>;
  recordNeurotype: ReturnType<typeof recordNeurotype>;
  addValueCard: ReturnType<typeof addValueCard>;
  recordResponse: ReturnType<typeof recordResponse>;
  removeNeurotype: ReturnType<typeof removeNeurotype>;
  removeValueCard: ReturnType<typeof removeValueCard>;
}

// ============================================================================
// FORM HANDLERS (state-reading, for UI binding)
// ============================================================================

/**
 * Record a neurotype entry from form fields (state-reading handler).
 * Reads systemField + resultField from state; upserts into selfModel;
 * clears resultField after recording.
 */
export const recordNeurotypeFromForm = handler<
  unknown,
  {
    selfModel: Writable<SelfModel>;
    systemField: Writable<NeurotypeSystem>;
    resultField: Writable<string>;
  }
>((_event, { selfModel, systemField, resultField }) => {
  const result = resultField.get().trim();
  if (!result) return;
  const system = systemField.get();
  const entry: Neurotype = {
    system,
    result,
    source: "self-reported",
    recordedAt: safeDateNow(),
  };
  selfModel.set(upsertNeurotype(selfModel.get(), entry));
  resultField.set("");
});

/**
 * Remove a neurotype by system (state-reading handler, for per-row binding).
 */
export const removeNeurotypeBySystem = handler<
  unknown,
  { selfModel: Writable<SelfModel>; system: NeurotypeSystem }
>((_event, { selfModel, system }) => {
  selfModel.set(withoutNeurotype(selfModel.get(), system));
});

// ============================================================================
// MAIN PATTERN
// ============================================================================

const Self = pattern<SelfInput, SelfOutput>(
  ({ selfModel: injectedSelfModel }) => {
    // Use the injected cell when provided (e.g. from tests); otherwise own one.
    // The explicit .for("selfModel") is required here: `new Writable(...)` sits
    // on the RIGHT of ??, so the CTS transformer does NOT auto-inject a .for
    // cause for it. Without this call the owned cell has no stable id.
    const selfModel = injectedSelfModel ??
      new Writable<SelfModel>(EMPTY_SELF_MODEL).for("selfModel");

    // Local form field cells
    const systemField = new Writable<NeurotypeSystem>("mbti").for(
      "systemField",
    );
    const resultField = new Writable<string>("").for("resultField");

    const neurotypeSystemItems: { label: string; value: NeurotypeSystem }[] = [
      { label: "MBTI", value: "mbti" },
      { label: "Enneagram", value: "enneagram" },
      { label: "Big Five", value: "big5" },
      { label: "Custom", value: "custom" },
    ];

    return {
      [NAME]: "My Self",
      // [UI] must be a static VNode — not wrapped in computed().
      [UI]: (
        <cf-vstack gap="4" style={{ padding: "16px" }}>
          <h2
            style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "600" }}
          >
            Self Model
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "#6b7280" }}>
            Your private neurotype self-report. Never shared.
          </p>

          <cf-vstack gap="2">
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
              Record Neurotype
            </h3>
            <cf-hstack gap="2" align="end">
              <cf-select
                $value={systemField}
                items={neurotypeSystemItems}
                style="min-width: 130px;"
              />
              <cf-input
                $value={resultField}
                placeholder="e.g. INTJ, 5w4…"
                style="flex: 1;"
              />
              <cf-button
                onClick={recordNeurotypeFromForm({
                  selfModel,
                  systemField,
                  resultField,
                })}
              >
                Record
              </cf-button>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="2">
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
              Neurotypes
            </h3>
            {selfModel.key("neurotypes").map((n) => (
              <cf-hstack gap="2" align="center">
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: "600",
                    minWidth: "90px",
                  }}
                >
                  {n.system}
                </span>
                <span style={{ fontSize: "13px", flex: "1" }}>{n.result}</span>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={removeNeurotypeBySystem({
                    selfModel,
                    system: n.system,
                  })}
                >
                  ✕
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
        </cf-vstack>
      ),
      selfModel,
      // Bind each handler to this instance's selfModel cell.
      recordNeurotype: recordNeurotype({ selfModel }),
      addValueCard: addValueCard({ selfModel }),
      recordResponse: recordResponse({ selfModel }),
      removeNeurotype: removeNeurotype({ selfModel }),
      removeValueCard: removeValueCard({ selfModel }),
    };
  },
);

export default Self;
