import {createCell, createComputed, hold, mapStream, config} from '../common-frp'
import { events } from '../dom'

config.debug = true

const button = document.getElementById('button')!

const clicks = events(button, 'click')

const xPos = mapStream(clicks, (event) => {
  const mouseEvent = event as MouseEvent
  return mouseEvent.clientX
})

const currentX = hold(xPos, 0, 'currentX')

const a = createCell(0, 'foo')

setInterval(() => {
  a.send(a.get() + 1)
}, 1000)

const b = createComputed([a, currentX], (a) => a + 1)
const c = createComputed([a, currentX], (a) => a + 2)
const d = createComputed([b, c], (b, c) => b + c)

// You should only see one log message per update
d.sink({
  send: (x) => console.log(x)
})