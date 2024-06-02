import {Cell, Computed, config} from '../common-frp'

config.debug = true

const a = Cell(0, 'foo')

setInterval(() => {
  a.send(a.get() + 1)
}, 1000)

const b = Computed([a], (a) => a + 1)

b.sink({
  send: (b) => console.log(b)
})