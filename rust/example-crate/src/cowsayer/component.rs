// Generates a "guest" trait based on the specified [WIT][1] definition
//
// [1]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
wit_bindgen::generate!({
    world: "cowsay",
});

use super::native::{Cows as NativeCows, Cowsayer as NativeCowsayer};
use exports::cow::{Cows, Guest};

impl From<Cows> for NativeCows {
    fn from(value: Cows) -> Self {
        match value {
            Cows::Default => NativeCows::Cow,
            Cows::Owl => NativeCows::Owl,
        }
    }
}

struct Cowsayer;

impl Guest for Cowsayer {
    fn say(text: String, cow: Option<Cows>) -> String {
        NativeCowsayer::say(text, cow.map(|cow| cow.into()))
    }
}

// Macro generates exportable Wasm Component functions that call into our
// implementation
export!(Cowsayer);
