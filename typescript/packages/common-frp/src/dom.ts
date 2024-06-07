import { generate } from './stream.js'

export const events = (
  element: HTMLElement,
  name: string
) => generate((send: (value: Event) => void) => {
  element.addEventListener(name, send)
  return () => element.removeEventListener(name, send)
})
