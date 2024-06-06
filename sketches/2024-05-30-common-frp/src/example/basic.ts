import { config } from '../index'
import { scan } from '../stream'
import { effect } from '../signal'
import { events } from '../dom'

config.debug = true

const button = document.getElementById('button')!

const clicks = events(button, 'click')

const clickCount = scan(clicks, (state, _) => state + 1, 0)

effect(clickCount, x => {
  button.textContent = `Clicks: ${x}`
  console.log(x)
})