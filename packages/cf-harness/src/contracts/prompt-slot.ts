export type PromptSlotRole = "direct-command" | "context" | "quote";

export interface PromptSlotBinding {
  type: "cf-harness.prompt-slot-binding";
  role: PromptSlotRole;
  kernelName: string;
  surface: string;
  subject?: string;
  eventId?: string;
  valueDigest?: string;
  slotDigest?: string;
  snapshotDigest?: string;
  targetPath?: string;
  sourceRef?: string;
}

export interface CreateCliPromptSlotBindingOptions {
  kernelName: string;
  role?: PromptSlotRole;
  surface?: string;
  subject?: string;
  eventId?: string;
  valueDigest?: string;
  slotDigest?: string;
}

export const createCliPromptSlotBinding = (
  options: CreateCliPromptSlotBindingOptions,
): PromptSlotBinding => ({
  type: "cf-harness.prompt-slot-binding",
  role: options.role ?? "direct-command",
  kernelName: options.kernelName,
  surface: options.surface ?? "cli",
  ...(options.subject !== undefined ? { subject: options.subject } : {}),
  ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
  ...(options.valueDigest !== undefined
    ? { valueDigest: options.valueDigest }
    : {}),
  ...(options.slotDigest !== undefined
    ? { slotDigest: options.slotDigest }
    : {}),
});
