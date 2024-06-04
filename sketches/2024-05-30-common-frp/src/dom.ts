import { generateStream } from './common-frp'

export const events = (
  element: HTMLElement,
  name: string
) => generateStream((send: (value: Event) => void) => {
  element.addEventListener(name, send)
  return () => element.removeEventListener(name, send)
})