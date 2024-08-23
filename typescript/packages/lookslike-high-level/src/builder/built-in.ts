import { lift } from "./module.js";
import { Value } from "./types.js";

export const generateData = lift<
  { prompt: string; result?: any; schema: any },
  { pending: boolean; result: any; partial: any; error: any }
>((() => {}) as any) as <T = any>(
  input: Value<{ prompt: string; result?: T; schema: any }>
) => Value<{ pending: boolean; result: T; partial: T; error: any }>;
