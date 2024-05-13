use example_crate::{Cows, Cowsayer};

pub fn main() {
    println!("{}", Cowsayer::say("moo".into(), None));
    println!("{}", Cowsayer::say("hoo".into(), Some(Cows::Owl)));
}
