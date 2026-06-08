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
  const current = selfModel.get();
  const entry: Neurotype = {
    system,
    result,
    detail,
    source,
    recordedAt: safeDateNow(),
  };
  const idx = current.neurotypes.findIndex((n) => n.system === system);
  if (idx === -1) {
    selfModel.set({
      ...current,
      neurotypes: [...current.neurotypes, entry],
    });
  } else {
    const updated = current.neurotypes.map((n, i) => (i === idx ? entry : n));
    selfModel.set({ ...current, neurotypes: updated });
  }
});

/** Append a ValueCard. */
export const addValueCard = handler<
  AddValueCardEvent,
  { selfModel: Writable<SelfModel> }
>(({ title, description, weight, sourcePromptId }, { selfModel }) => {
  const current = selfModel.get();
  const card: ValueCard = { title, description, weight, sourcePromptId };
  selfModel.set({ ...current, values: [...current.values, card] });
});

/** Append a QAResponse. Timestamp is set automatically via safeDateNow(). */
export const recordResponse = handler<
  RecordResponseEvent,
  { selfModel: Writable<SelfModel> }
>(({ promptId, prompt, answer, track }, { selfModel }) => {
  const current = selfModel.get();
  const response: QAResponse = {
    promptId,
    prompt,
    answer,
    track,
    answeredAt: safeDateNow(),
  };
  selfModel.set({ ...current, responses: [...current.responses, response] });
});

/** Remove the neurotype entry whose system matches. No-op if not found. */
export const removeNeurotype = handler<
  RemoveNeurotypeEvent,
  { selfModel: Writable<SelfModel> }
>(({ system }, { selfModel }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    neurotypes: current.neurotypes.filter((n) => n.system !== system),
  });
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
  const current = selfModel.get();
  selfModel.set({
    ...current,
    values: current.values.filter((_, i) => i !== index),
  });
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
// MAIN PATTERN
// ============================================================================

const Self = pattern<SelfInput, SelfOutput>(
  ({ selfModel: injectedSelfModel }) => {
    // Use the injected cell when provided (e.g. from tests); otherwise own one.
    const selfModel = injectedSelfModel ??
      new Writable<SelfModel>(EMPTY_SELF_MODEL).for("selfModel");

    return {
      [NAME]: "My Self",
      // [UI] must be a static VNode — not wrapped in computed().
      [UI]: (
        <div style={{ padding: "16px", fontFamily: "sans-serif" }}>
          <h2
            style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: "600" }}
          >
            Self Model
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "#6b7280" }}>
            Your private values, neurotype, and reflective answers. Never
            shared.
          </p>
        </div>
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
