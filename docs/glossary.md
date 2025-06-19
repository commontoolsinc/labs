# Glossary

## Spell

Unit of computation that describes transformation from the set of inputs to the set of outputs. In practice it is manifested as a typescript function that takes an object with set of properties and returns an object with a set of outputs.

It is worth pointing out that while typescript function is used it does not actually defines a computation, instead it is a way to build a computation pipeline that flows through input [cell]s into output [cell]s.


## Cell

Cell is a unit of reactivity, conceptually it is similar to a cell in a spreadsheet. It holds a value that can be updated by writing into a cell. Cell can also have subscribers that will be called whenever cell content is updated allowing them to compute derived state which will end up propgating it to some output cell.

## Charm

Charm is a [spell] invocation binding set of [cell]s as inputs and set of [cell]s as outputs, creating an execution graph. It may help to think of [spell] as an open electric circuit, in this case [charm] would be a closed electric circuit as current will flow through it. Different analogy could be to think of [charm] as a process, where's [spell] would be a program and [cell]s would be program inputs and outputs.

[spell]:#spell
[cell]:#cell
[charm]:#charm
