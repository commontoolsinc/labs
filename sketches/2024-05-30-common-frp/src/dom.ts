import { stream } from './index'

export const events = (
  element: HTMLElement,
  name: string
) => stream.create((send: (value: Event) => void) => {
  element.addEventListener(name, send)
  return () => element.removeEventListener(name, send)
})