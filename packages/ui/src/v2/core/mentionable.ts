import { NAME } from "@commontools/api";

export interface Mentionable {
  [NAME]: string;
  [key: string]: unknown;
}

export type MentionableArray = Mentionable[];
