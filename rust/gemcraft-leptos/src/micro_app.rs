use leptos::html::*;
use leptos::*;
use regex::Regex;
use std::rc::Rc;
use crate::tabs::{Tab, TabControl};

use quick_xml::{events::Event, Reader};
use std::io::Cursor;

#[derive(Clone, Debug, PartialEq, Default)]
pub struct MicroAppIdea {
    pub name: String,
    pub tagline: String,
    pub icon: String,
    pub spec: String,
    pub sketch: String,
    pub view_model: String,
}

pub fn parse_micro_app_ideas(input: &str) -> Vec<MicroAppIdea> {
    let sketches = extract_sketches(input);
    parse_xml_and_combine(input, sketches)
}

fn extract_sketches(input: &str) -> Vec<String> {
    let re = Regex::new(r"(?s)<sketch>(.*?)</sketch>").unwrap();
    re.captures_iter(input)
        .map(|cap| cap[1].to_string())
        .collect()
}

fn parse_xml_and_combine(input: &str, sketches: Vec<String>) -> Vec<MicroAppIdea> {
    let mut reader = Reader::from_str(input);
    reader.trim_text(true);

    let mut ideas = Vec::new();
    let mut buf = Vec::new();
    let mut current_idea = MicroAppIdea::default();
    let mut current_field = String::new();
    let mut sketch_index = 0;

    loop {
        match reader.read_event(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match e.name() {
                    b"micro-app-idea" => current_idea = MicroAppIdea::default(),
                    b"name" | b"tagline" | b"icon" | b"spec" | b"view-model" => {
                        current_field = String::from_utf8_lossy(e.name()).into_owned();
                    }
                    b"sketch" => {
                        if let Some(sketch) = sketches.get(sketch_index) {
                            current_idea.sketch = sketch.clone();
                            sketch_index += 1;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                let text = e.unescape_and_decode(&reader).unwrap();
                match current_field.as_str() {
                    "name" => current_idea.name = text,
                    "tagline" => current_idea.tagline = text,
                    "icon" => current_idea.icon = text,
                    "spec" => current_idea.spec = text,
                    "view-model" => current_idea.view_model = text,
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name() == b"micro-app-idea" {
                    ideas.push(current_idea.clone());
                }
                current_field.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => panic!("Error at position {}: {:?}", reader.buffer_position(), e),
            _ => {}
        }
        buf.clear();
    }

    ideas
}

#[component]
pub fn MicroAppGrid(
    input: ReadSignal<String>,
    #[prop(into)] on_save: Callback<()>,
) -> impl IntoView {


    view! {
        <>            
            <div class="micro-app-grid">
                <For
                    each=move || parse_micro_app_ideas(&input.get())
                    key=|idea| idea.name.clone()
                    children=move |idea| {
                        let tabs = vec![
                            Tab {
                                id: "tab1".into(),
                                title: "App".into(),
                                content: Rc::new(move || view! { 
                                    <div class="micro-app-spec">
                                        <div class="micro-app-svg" inner_html=&idea.sketch></div>
                                        <div class="data-gem">
                                            <div class="small icon">{&idea.icon}</div>
                                        </div>
                                        <h3 class="micro-app-title">{&idea.name}</h3>
                                        <h4 class="micro-app-spec-title"></h4>
                                        <div class="micro-app-spec-content">{&idea.spec}</div>
                                    </div>
                                }.into_any()),
                            },
                            Tab {
                                id: "tab2".into(),
                                title: "Model".into(),
                                content: Rc::new(move || view! { <pre>{&idea.view_model}</pre> }.into_any()),
                            },
                            Tab {
                                id: "tab3".into(),
                                title: "Code".into(),
                                content: Rc::new(move || view! { <div>"Content for Tab 3"</div> }.into_any()),
                            },
                        ];

                        view! {
                            <div class="micro-app-item">
                                <TabControl tabs=tabs default_tab="tab1".into() />
                                <button on:click=move |_| on_save(())>
                                Save
                                </button>
                            </div>
                        }
                    }
                />
            </div>
        </>
    }
}
