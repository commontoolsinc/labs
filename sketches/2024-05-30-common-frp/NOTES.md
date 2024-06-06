# Notes

Devlog, reverse chronological order.

Contains rough notes and references while designing.

## 2024-06-05

Proposed semantics after discussing with Berni.

- Cells
    - Discrete
    - Use transactions to synchronize
    - Last-write-wins at input boundary (e.g. too many clicks results in last click winning).
- Streams
    - Discrete
    - Uses separate transaction system to ensure one event is always one event
    - Buffered semantics. (e.g. too many clicks results in more transactions being added to queue)

Implications:

- Streams and events do not happen during shared moments
- Streams may NEVER sample cell state
    - Since they aren't synchronized, sampling might mean seeing the graph in an inconsistent state.
    - Streams may only get values from upstream streams
    - However, you may produce a stream from cell changes
- Streams are essentially "async" computation, while cells are "sync"

---

> Really quickly: reactive-banana is definitely pull-based not push-pull. reactive is push-pull. Yampa and netwire are arrowized. There are FRPs which allow "accumulating values" but don't allow "switching", FRPs which allow "switching" but not "accumulating values". Both of those are "simple" FRP. Arrowized FRP allows switching and accumulating and uses arrows to control the danger of combining those features. Monadic FRP like reactive-banana, sodium, and elerea use other careful mechanisms to ensure that switching and accumulating don't interact too much. – [J. Abrahamson  Oct 2, 2014 at 20:04](https://stackoverflow.com/questions/26164135/how-fundamentally-different-are-push-pull-and-arrowized-frp#comment41026849_26164135)

> Arrowized FRP also has the neat feature that signals are always stated in context of their inputs which lets you transform the outputs covariantly and the inputs contravariantly in order to better simulate interactive FRP. See Genuinely Functional User Interfaces by Courtney and Elliott for a great example of that feature. – [J. Abrahamson Oct 2, 2014 at 20:05](https://stackoverflow.com/questions/26164135/how-fundamentally-different-are-push-pull-and-arrowized-frp#comment41026887_26164135)


## 2024-05-30

### Design

- Discrete classical FRP
    - Streams
        - Events over time. Update during a moment.
        - Independent. They may not depend upon each other's state.
        - They may depend upon cells, but must get the cell's state before
          the cell graph is updated.
        - They act as IO input to the cell graph.
    - Cells
        - Reactive containers for state. Always have a value.
    - Computed Cells
        - Reactive computed states, derived from cells and other computed cells.

### Implementation

- Transaction 
    - Update streams: Update streams:
    - Update cells: mutate cell state and mark computed cells dirty (push)
        - Dispatch "I am dirty" notification immediately during cell update phase to downstream cells 
    - Update sinks: get updated cell and computed state. Computed state is recomputed if dirty.
        - Subscribe with sinks

### Restricted operators

- It may be worth offering operators that do not allow arbitrary Turing-complete function definitions. E.g. a restricted subset of data operators taken from SQL or Linq
    - `select(keyPath: string)` - a restricted form of map
    - `where(selector: formula)` - a restricted form of filter
    - `groupBy()`
    - `orderBy()`
    - `union()`, `intersect()` - restricted forms of join/merge
    - `count()`, `min()`, `max()`, `sum()`, `avg()`, `truncate()` - restricted forms of computation

### Classical FRP

Qualities:

- Comes in discrete and continuous flavors. We only care about discrete for our purposes.
- Behaviors and events (also called cells and streams, or signals and streams)
    - Behaviors are reactive containers for state (think spreadsheet cell)
    - Events are streams of events over time
    - Both are synchronized by a transaction system that makes sure changes happen during discrete "moments" in time, and inconsistent graph states are not observable.
- Resulting computation graph is pure.
- Theory pioneered by Conal Elliott.
- 10 primitives:
    - map, merge, hold, snapshot, filter, lift, never, constant, sample, and switch. (Functional Reactive Programming, 2.3, Manning)

> Each FRP system has its own policy for merging simultaneous events. Sodium’s policy is as follows:
>
> - If the input events on the two input streams are simultaneous, merge combines them into one. merge takes a combining function as a second argument for this purpose. The signature of the combining function is A combine(A left, A right).
> -The combining function is not used in the (usually more common) case where the input events are not simultaneous.
> -You invoke merge like this: s1.merge(s2, f). If merge needs to combine simul- taneous events, the event from s1 is passed as the left argument of the combin- ing function f, and the event from s2 is passed on the right.
> -The s1.orElse(s2) variant of merge doesn’t take a combining function. In the simultaneous case, the left s1 event takes precedence and the right s2 event is dropped. This is equivalent to s1.merge(s2, (l, r) -> l). The name orElse() was chosen to remind you to be careful, because events can be dropped.
>
> This policy has some nice results:
> - There can only ever be one event per transaction in a given stream.
> - There’s no such thing as event-processing order within a transaction. All events that occur in different streams within the same transaction are truly simultaneous in that there’s no detectable order between them.
>
> (Functional Reactive Programming, 2.6.1, Manning)

Talks:

- [A More Elegant Specification for Functional Reactive Programming, Conal Elliott](https://www.youtube.com/watch?v=9vMFHLHq7Y0)

Libraries:

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
- [S.js](https://github.com/adamhaile/S)
    - implements transactions and dynamic graph with single-transaction callback registration, eliminating listener memory leaks.
- [Arrow.js](https://www.arrow-js.com/docs/)
    - Focuses on reactive objects, rather than values
    - Key-path style indexing using Proxy
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

### Concepts

- Paper: [Push-pull FRP](http://conal.net/papers/push-pull-frp/push-pull-frp.pdf), Conal Elliott
- Book: [Functional Reactive Programming](https://www.manning.com/books/functional-reactive-programming), Manning 2016
- Talk: [Controlling space and time: understanding the many formulations of FRP](https://www.youtube.com/watch?v=Agu6jipKfYw), Evan Czaplicki
- Blog: [The Evolution of Signals in Javascript](https://dev.to/this-is-learning/the-evolution-of-signals-in-javascript-8ob). Notes on low-level implementation of signal libraries, from the creator of SolidJS.
- Blog: [Introduction to fine-grained reactivity](https://dev.to/ryansolid/a-hands-on-introduction-to-fine-grained-reactivity-3ndf) from the creator of SolidJS.
- GitHub: [General Theory of Reactivity](https://github.com/kriskowal/gtor)

### Cold vs. Hot Observables

The distinction between cold and hot observables (or their equivalent) is a significant part of many FRP systems. Cold observables are those where the data-producing sequence starts anew for each subscriber, whereas hot observables share a single execution path among all subscribers. This distinction affects how data streams are multicast to multiple observers.

- Cold observable: creates a data producer for each subscriber.
    - The observable is a pure transformation over the data producer.
    - Examples: [Reducers in Clojure](https://clojure.org/reference/reducers), [RxJS Observables](https://rxjs.dev).
- Hot observable: Multicast. Maintains a list of subscribers and dispatches to them from a single data producing source.
    - Examples: [share](https://rxjs.dev/api/index/function/share) in RxJS.
    - Has to deal with callback cleanup bookkeeping in dynamic graphs.

### Pipeable operators

Following RxJS, we enable piping through unary functions. This is a functional alternative to method chaining.

> Problems with the patched operators for dot-chaining are:
>
> Any library that imports a patch operator will augment the Observable.prototype for all consumers of that library, creating blind dependencies. If the library removes their usage, they unknowingly break everyone else. With pipeables, you have to import the operators you need into each file you use them in.
>
> Operators patched directly onto the prototype are not "tree-shakeable" by tools like rollup or webpack. Pipeable operators will be as they are just functions pulled in from modules directly.
>
> Unused operators that are being imported in apps cannot be detected reliably by any sort of build tool or lint rule. That means that you might import scan, but stop using it, and it's still being added to your output bundle. With pipeable operators, if you're not using it, a lint rule can pick it up for you.
>
> Functional composition is awesome. Building your own custom operators becomes much easier, and now they work and look just like all other operators in rxjs. You don't need to extend Observable or override lift anymore.

> [Pipeable Operators](https://v6.rxjs.dev/guide/v6/pipeable-operators)

And:

> "pipeable" operators is the current and recommended way of using operators since RxJS 5.5. The main difference is that it's easier to make custom operators and that it's better treeshakable while not altering some global Observable object that could possible make collisions if two different parties wanted to create an operator of the same name. - [StackOverflow](https://stackoverflow.com/questions/48668701/what-is-pipe-for-in-rxjs)