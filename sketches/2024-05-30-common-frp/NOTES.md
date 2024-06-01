# Notes

Rough notes and references while designing.

## Prior art

### Classical FRP

Qualities:

- Behaviors and events (also called cells and streams, or signals and streams)
    - Behaviors are reactive containers for state (think spreadsheet cell)
    - Events are streams of events over time
    - Both are synchronized by a transaction system that makes sure changes happen during discrete "moments" in time, and inconsistent graph states are not observable.
- Comes in discrete and continuous flavors. We only care about discrete for our purposes.
- Resulting computation graph is pure.
- Theory pioneered by Conal Elliott.
- Full Turing-complete theory of reactive computation.

Libraires:

- [Sodium FRP](https://github.com/SodiumFRP)
    - [Sodium Typescript](https://github.com/SodiumFRP/sodium-typescript/tree/master/src/lib/sodium)

### Signals

Qualities:

- Combines event streams and behaviors into a single concept.
- Often uses single-transaction callback registration technique developed by S.js
- Often uses push-pull FRP
- Often uses closure and a "reactive scope" stack machine with a helper like `useEffect()` to register listeners

Libraries:

- [TC39 Signals Proposal](https://github.com/tc39/proposal-signals)
- [SolidJS](https://www.solidjs.com/)
- [Preact Signals](https://preactjs.com/guide/v10/signals/)
- [S.js](https://github.com/adamhaile/S) implements transactions and dynamic graph with single-transaction callback registration, eliminating listener memory leaks.
- [Elm Signals 3.0.0](https://github.com/elm-lang/core/blob/3.0.0/src/Native/Signal.js). Deprecated, but the implementation can be found here. 1st order FRP.

### Observables

Qualities:

- No transaction system
- No state (streams only)
- Largely static graphs (1st-order FRP) with explicit subscription cancellation for dynamic graphs

Libraries:

- [RxJS](https://rxjs.dev/)
- [TC39 Observable Proposal](https://github.com/tc39/proposal-observable)
- [Apple Combine](https://developer.apple.com/documentation/combine/)

## Concepts

- Paper: [Push-pull FRP](http://conal.net/papers/push-pull-frp/push-pull-frp.pdf), Conal Elliott
- Book: [Functional Reactive Programming](https://www.manning.com/books/functional-reactive-programming), Manning 2016
- Talk: [Controlling space and time: understanding the many formulations of FRP](https://www.youtube.com/watch?v=Agu6jipKfYw), Evan Czaplicki
- Blog: [The Evolution of Signals in Javascript](https://dev.to/this-is-learning/the-evolution-of-signals-in-javascript-8ob). Notes on low-level implementation of signal libraries, from the creator of SolidJS.
- Blog: [Introduction to fine-grained reactivity](https://dev.to/ryansolid/a-hands-on-introduction-to-fine-grained-reactivity-3ndf) from the creator of SolidJS.
- GitHub: [General Theory of Reactivity](https://github.com/kriskowal/gtor)
