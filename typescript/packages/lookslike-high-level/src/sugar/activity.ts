import { refer, Reference } from "merkle-reference";
import z from "zod";
import { Ref } from "./zod.js";
import { importEntity, list } from "./sugar.jsx";
import { $, Instruction } from "@commontools/common-system";

export const activityRef = refer({ activity: 1 });

export const LogEntry = z
  .object({
    modified: z.string(),
    message: z.string(),
    target: Ref,
  })
  .describe("LogEntry");

export const logEntries = list(LogEntry, LogEntry.omit({ target: true })).match(
  $.self,
  "common/activity",
  $.listItem,
);

export function log(entity: Reference, message: string): Instruction[] {
  console.log("ACTIVITY", entity, message);
  const entry = {
    modified: new Date().toString(),
    message,
    target: entity,
  };

  const { self, instructions } = importEntity(entry, LogEntry);

  return [
    ...instructions,
    { Assert: [activityRef, "log", self] },
    { Assert: [entity, "common/activity", self] },
  ];
}
