import { Instruction, Reference } from "@commontools/common-system";
import { tags } from "./inbox.js";

export function addTag(target: Reference, ...tagList: string[]): Instruction[] {
  return tagList.map(tag => ({ Assert: [tags, tag, target] }));
}

export function removeTag(target: Reference, ...tagList: string[]): Instruction[] {
  return tagList.map(tag => ({ Retract: [tags, tag, target] }));
}
