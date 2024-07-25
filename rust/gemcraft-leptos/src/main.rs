mod data;
mod extract;
mod gem;
mod llm;

use leptos::*;
use logging::log;
use std::collections::HashMap;
use uuid::Uuid;

use data::{ClassificationData, DataGem};
use gem::{DataGemEditor, MiniDataGemPreview};

fn main() {
    console_error_panic_hook::set_once();

    mount_to_body(|| view! { <App /> })
}

#[component]
fn App() -> impl IntoView {
    let gems = create_rw_signal(HashMap::<String, DataGem>::new());
    let (selection, set_selection) = create_signal(Vec::<String>::new());
    let (imagined_apps, set_imagined_apps) = create_signal(String::new());

    let on_toggle_selection = move |id| {
        set_selection.update(|current| {
            if current.contains(&id) {
                current.retain(|x| x != &id);
            } else {
                current.push(id.clone());
            }
        })
    };

    let on_classify = move |(id, classification, description, json_data)| {
        gems.update(|gems| {
            gems.insert(
                id,
                DataGem {
                    classification: Some(classification),
                    description,
                    json_data,
                },
            );
        });
    };

    let combine_data = create_action(move |_| {
        async move {
            // use only selected gems
            let selectedData = gems
                .get()
                .iter()
                .filter(|(id, _)| selection.get().contains(id))
                .map(|(_, gem)| gem.clone())
                .collect();
            let data = llm::combine_data(selectedData, "".to_string()).await;
            match data {
                Ok(data) => {
                    log!("Response: {:?}", data);
                    set_imagined_apps.set(data.output);
                }
                Err(e) => {
                    log!("Error: {:?}", e);
                }
            }
        }
    });

    view! {
        <div class="app">
        <div>
        {move || gems()
            .into_iter()
            .map(|(id, gem)| view! { <DataGemEditor id=id.to_string() gem=gem selected=selection.get().contains(&id) on_classify=on_classify on_toggle=on_toggle_selection /> })
            .collect_view()}
            <button on:click=move |_| gems.update(|gems| gems.clear())>"Clear"</button>
            <button on:click=move |_| gems.update(|gems|  {
                let id = Uuid::new_v4().to_string();
                gems.insert(
                    id,
                    DataGem {
                        classification: Some(ClassificationData {
                            title: "Test".to_string(),
                            content_type: "Test".to_string(),
                            emoji: "🔥".to_string(),
                            sensitivity: "Test".to_string(),
                        }),
                        description: "Test".to_string(),
                        json_data: "{}".to_string(),
                    });
            })>
                "Add Gem"
            </button>
            </div>
            <div>
                <div class="gem-list">
                    {move || selection.get().iter().map(|id| view! { <MiniDataGemPreview gem=gems.get().get(id).unwrap().clone() /> }).collect_view()}
                </div>
                <button on:click=move |_| combine_data.dispatch(gems)>"Imagine"</button>
                <pre>{move || imagined_apps.get()}</pre>
            </div>
        </div>
    }
}
