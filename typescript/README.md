# TypeScript

This workspace contains TypeScript that at times may target the web, Deno, Node.js or arbitrary Wasm runtimes.

## Setup

Building requires building some Rust components. Ensure the cargo target and tools are configured:

```
rustup target add wasm32-wasi
cargo install wasm-tools wit-deps-cli

npm install
```
