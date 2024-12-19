import { z } from "zod";

export const Ref = z.object({}).nullable().default(null);
export const UiFragment = z.any().nullable().default(null)
