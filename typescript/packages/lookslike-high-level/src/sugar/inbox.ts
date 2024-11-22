import { refer } from "@commontools/common-system";

export const chatHistory = inbox('chatHistory')
export const tags = inbox('tags')

export function inbox(name: string) {
  return refer({ inbox: name, v: 1 })
}
