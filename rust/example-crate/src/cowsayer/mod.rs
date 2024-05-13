mod native;

pub use native::*;

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
mod component;

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
pub use component::*;
