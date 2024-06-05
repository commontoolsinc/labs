import {createCell, createComputed, hold, mapStream, config} from '../common-frp'
import { events } from '../dom'

config.debug = true

const button = document.getElementById('button')!

const clicks = events(button, 'click')

const xPos = mapStream(clicks, (event) => {
  const mouseEvent = event as MouseEvent
  return mouseEvent.clientX
})

const currentX = hold(xPos, 0)

const a = createCell(0)

const b = createComputed([a, currentX], (a, b) => a + b + 1)
const c = createComputed([a, currentX], (a, b) => a + b + 2)
const d = createComputed([b, c], (b, c) => b + c)

// You should only see one log message per update
d.sink(x => console.log(x))