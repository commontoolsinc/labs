# Glossary

## ACL (Access Control List)

Defines who can read or write specific data in a space, forming part of the data's access policy.

## Cell

Cell is a unit of reactivity, conceptually it is similar to a cell in a spreadsheet. It holds a value that can be updated by writing into a cell. Cell can also have subscribers that will be called whenever cell content is updated allowing them to compute derived state which will end up propgating it to some output cell.

## CFC (Contextual Flow Control)

A security model combining information flow control with contextual integrity; enforces policies on how data is used, attached to schemas and validated both statically and dynamically.

## Charm

Charm is a [spell] invocation binding set of [cell]s as inputs and set of [cell]s as outputs, creating an execution graph. It may help to think of [spell] as an open electric circuit, in this case [charm] would be a closed electric circuit as current will flow through it. Different analogy could be to think of [charm] as a process, where's [spell] would be a program and [cell]s would be program inputs and outputs.

## CRDT (Conflict-free Replicated Data Type)

A data structure that can resolve conflicts automatically in distributed systems. Used selectively, e.g. for collaborative text editing.

## Deno

A JavaScript/TypeScript runtime used on the server side of Open Ocean.

## did:key

A decentralized identifier derived from a keypair. Used to uniquely identify and control a Space.

## Event Handler

Code that reacts to events and may update other cells or trigger further actions.

## LLM (Large Language Model)

AI models such as Claude or ChatGPT that can be called from recipes for AI-generated outputs.

## Memory

The document-oriented storage system used by Open Ocean, organized into Spaces. Provides syncing, schema enforcement, and verifiability.

## Reactive Framework

The runtime engine behind Open Ocean that computes state updates in a deterministic way, using dependency graphs of reactive cells.

## Recipe

A function that defines a reactive graph. Can produce UI, derived data, or streams. Used like components in other reactive frameworks.

## Safe Rendering

The secure, isolated rendering of recipe-generated UI, considered part of the Trusted Computing Base (TCB).

## Space

A namespace for user data, identified by a did:key. Users control access and permissions via UCANs and ACLs.

## Spell

Unit of computation that describes transformation from the set of inputs to the set of outputs. In practice it is manifested as a typescript function that takes an object with set of properties and returns an object with a set of outputs.

It is worth pointing out that while typescript function is used it does not actually defines a computation, instead it is a way to build a computation pipeline that flows through input [cell]s into output [cell]s.

## TCB (Trusted Computing Base)

The minimal set of components that must be trusted to enforce security. In Open Ocean, this includes rendering infrastructure (e.g. web components), and excludes user-authored recipes, which are sandboxed.

## UCAN (User Controlled Authorization Network)

A capability-based auth system that allows delegating access rights using signed tokens.

## VDOM (Virtual DOM)

A data representation of UI elements returned by recipes, which the runtime turns into rendered HTML.

[spell]:#spell
[cell]:#cell
[charm]:#charm
[acl]:#acl-access-control-list
[cfc]:#cfc-contextual-flow-control
[crdt]:#crdt-conflict-free-replicated-data-type
[deno]:#deno
[did:key]:#didkey
[event-handler]:#event-handler
[llm]:#llm-large-language-model
[memory]:#memory
[reactive-framework]:#reactive-framework
[recipe]:#recipe
[safe-rendering]:#safe-rendering
[space]:#space
[tcb]:#tcb-trusted-computing-base
[ucan]:#ucan-user-controlled-authorization-network
[vdom]:#vdom-virtual-dom
