pub enum Cows {
    Cow,
    Owl,
}

// A token struct that will implement the "guest" trait
pub struct Cowsayer;

impl Cowsayer {
    pub fn say(text: String, cow: Option<Cows>) -> String {
        match cow {
            Some(Cows::Owl) => {
                format!(
                    r#"{text}
   ___
  (o o)
 (  V  )
/--m-m-"#
                )
            }
            _ => {
                format!(
                    r#"{text}
  \\   ^__^
    \\  (oo)\\______
      (__)\\      )\/\\
          ||----w |
          ||     ||"#
                )
            }
        }
    }
}
