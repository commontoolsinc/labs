export type PromptWorkflowType =
  | "fix"
  | "edit"
  | "imagine"
  | "imagine-single-phase";

export interface PromptWorkflowForm {
  input: {
    rawInput: string;
    processedInput: string;
    existingPiece?: unknown;
    references: Record<string, unknown>;
  };
  classification: {
    workflowType: PromptWorkflowType;
    confidence: number;
    reasoning: string;
  } | null;
  plan: {
    features?: string[];
    description?: string;
    pieces?: unknown[];
  } | null;
  generation: {
    piece: unknown;
  } | null;
  meta: {
    pieceManager?: {
      getSpaceName(): string | undefined;
    };
    permittedWorkflows?: PromptWorkflowType[];
    generationId?: string;
    model?: string;
    isComplete: boolean;
    cache: boolean;
    llmRequestId?: string;
  };
}
