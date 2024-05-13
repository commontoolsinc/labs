# Example Crate

This crate implements a simple Rust library. It is able to be used in typical Rust programs, and it is also able to be compiled as a Wasm Component and run anywhere such a thing may be run (e.g., web browsers, Deno etc).

## Usage

To run a demo on your local target: `cargo run`.

To build a Wasm Component for the web: `./build-wasm-component.sh`

## References

- Wasm components: https://github.com/WebAssembly/component-model
- WIT: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
- WASI interfaces: https://wasi.dev/interfaces
- `wasm-tools`: https://github.com/bytecodealliance/wasm-tools
- `cargo-component`: https://github.com/bytecodealliance/cargo-component
- `warg`: https://warg.io/
  - "A secure registry protocol for Wasm packages"
- "Making JavaScript run fast on WebAssembly": https://bytecodealliance.org/articles/making-javascript-run-fast-on-webassembly
- "Changes to Rust's WASI targets": https://blog.rust-lang.org/2024/04/09/updates-to-rusts-wasi-targets.html