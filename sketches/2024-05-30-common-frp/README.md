# Common FRP

Common functional reactive programming utilities.

## Goals

- [x] Classical FRP with behaviors and events (also called cells and streams, or signals and streams)
    - [x] Behaviors (called cells) are reactive containers for state that can be formalized as functions of time
    - [x] Events (called streams) are streams of events over time
- [x] 1st order FRP (static graph)
- [ ] Graph description can be serialized to JSON
    - [x] All graph dependencies held in array (in contrast to S.js style or Signals style where graph is defined via VM execution trace)
- [x] Glitch free: updates happen during discrete moments using a transaction system
- [x] Transformations should happen during same transaction
- [ ] Transactions
    - [ ] (see experimental for WIP)
- [ ] Cycles
    - [ ] TODO: switch from microtask-based topological sorting to transaction-based push-pull (see experimental for WIP)
