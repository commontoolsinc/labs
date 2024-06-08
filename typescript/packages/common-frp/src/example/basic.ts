import { config } from '../shared.js'
import { scan } from '../stream.js'
import { effect } from '../signal.js'
import { events } from '../dom.js'

config.debug = true

const button = document.getElementById('button')!

const clicks = events(button, 'click')

const clickCount = scan(clicks, (state, _) => state + 1, 0)

effect([clickCount], x => {
  button.textContent = `Clicks: ${x}`
  console.log(x)
})
