import { createStream } from './stream'

export const events = (
  element: HTMLElement,
  name: string
) => createStream((send: (value: Event) => void) => {
  element.addEventListener(name, send)
  return () => element.removeEventListener(name, send)
})