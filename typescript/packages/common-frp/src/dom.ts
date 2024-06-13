import { subject, readonly, __sink__ } from './stream.js'

export const events = (
  element: HTMLElement,
  name: string
) => {
  const event = subject()
  element.addEventListener(name, event.send)
  return readonly({
    ...event,
    cancel: () => element.removeEventListener(name, event.send)
  })
}
