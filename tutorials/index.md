---
title: Guide to the Common Tools Runtime
subject: Tutorial
keywords: commontools
---

# Welcome to the Common Tools Runtime Guide

This guide will help you get started with the Common Tools runtime, from installation through advanced features.

It is still a work in progress.

## Contents

- **{doc}`install-ct`** - Get the runtime up and running
- **{doc}`llm-builtin`** - A quick tour
- **{doc}`state`** - Managing application state
- **{doc}`state_modify`** - How to modify state with user input 

## TODO items
* more complex state types
  * cell "object" make stats as an object
  * cell array, make inventory as an array
  * map() builtin
* pass reference to toggle an item (constant time)
* remove item via cell reference (O(n) via cell equality check)
* How to derive from two state inputs
* How to read a value
* recipe input and output - schemas
* cell creation via Default
* derive
* other builtins
  * ifelse
  * fetchdata
  * navigateTo
  * compileAndRun
  * llmDialog
* sorting shopping list (filter by key such as aisle)
