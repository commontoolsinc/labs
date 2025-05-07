import { DEFAULT_MODEL_NAME } from "./index.ts";

export type GenerationOptions = {
  generationId?: string;
  model?: string;
  cache?: boolean;
  space?: string;
};

export function applyDefaults<T extends Partial<GenerationOptions> | undefined>(
  options?: T,
): T & { model: string; cache: boolean } {
  return {
    model: DEFAULT_MODEL_NAME,
    cache: true,
    ...(options || {}),
  } as T & { model: string; cache: boolean };
}
