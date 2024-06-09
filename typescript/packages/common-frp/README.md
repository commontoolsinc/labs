# Common FRP

Common functional reactive programming utilities.

## Goals

- [x] Classical FRP with behaviors and events (also called cells and streams, or signals and streams)
    - [x] Behaviors (called streams) are reactive containers for state that can be formalized as functions of time
    - [x] Events (called streams) are streams of events over time
- [x] 1st order FRP (static graph)
- [ ] Graph description can be serialized to JSON
    - [x] All graph dependencies held in array (in contrast to S.js style or Signals style where graph is defined via VM execution trace)
    - [ ] Walk graph
- [x] Glitch free: updates happen during discrete moments using a transaction system
- [x] Transformations should happen during same transaction
- [x] Transactions
- [ ] Cycles supported for Signals
    - [ ] TODO need to improve [push-pull dirty marking logic](https://github.com/tc39/proposal-signals?tab=readme-ov-file#common-algorithms).
    - [ ] via something like a LoopCell (see Sodium)
    - [ ] via something like a stepper/scan
- [ ] Logical clock for streams
    - [ ] First pass, microtask batching (requires synchronous messages)
    - [ ] Second pass, transaction system
        - [ ] Events originate at time T
        - [ ] Events may be promises (allowing for async work). Returned value still emitted at logical time T.
        - [ ] Transaction system awaits each transaction promise completion before proceeding to next transaction
    - TODO investigate async generators as mechanism
        - [ ] Always return a value `[T, value]`