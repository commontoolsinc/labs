mod data;
mod db;
mod extract;
mod gem;
mod llm;
mod micro_app;
mod toggle;
mod tabs;

use html::Data;
use leptos::*;
use logging::log;
use std::collections::HashMap;
use uuid::Uuid;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use rand::prelude::*;
use rand::Rng;

use data::{ClassificationData, DataGem};
use gem::{DataGemEditor, MiniDataGemPreview};
use micro_app::{parse_micro_app_ideas, MicroAppGrid};
use tabs::{Tab, TabControl};
use crate::llm::LlmResponse;

fn main() {
    console_error_panic_hook::set_once();

    // let saved = db::list::<DataGem>("").unwrap();
    // for (id, gem) in saved {
    //     log!("Loaded saved gem {}: {:?}", id, gem);
    // }

    mount_to_body(|| view! { <App /> })
}

#[component]
fn App() -> impl IntoView {
    let gems = create_rw_signal(db::list::<DataGem>("").unwrap());
    let search = create_rw_signal(String::new());
    let (selection, set_selection) = create_signal(Vec::<String>::new());
    let (imagined_apps, set_imagined_apps) = create_signal(String::new());
    let (implemented_apps, set_implemented_apps) = create_signal(String::new());
    let (llm_model, set_llm_model) = create_signal(String::from("claude-3-5-sonnet-20240620"));

    let insert = |id: String, gem: DataGem, gems: &mut HashMap<String, DataGem>| {
        gems.insert(id.clone(), gem.clone());
        db::save("", &id, &gem);
    };

    let delete = |id: String, gems: &mut HashMap<String, DataGem>| {
        gems.remove(&id);
        db::delete("", &id);
    };

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
            insert(
                id,
                DataGem {
                    classification: Some(classification),
                    description,
                    json_data,
                    derived_from: Vec::new(),
                },
                gems,
            )
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
            let data = llm::combine_data(selectedData, search.get(), llm_model.get()).await;
            match data {
                Ok(data) => {
                    log!("Response: {:?}", data);
                    let output = data.output.replace("\\n", "\n");
                    set_imagined_apps.set(output);
                }
                Err(e) => {
                    log!("Error: {:?}", e);
                }
            }
        }
    });

    let on_save = move |_| {
        let data = imagined_apps.get();
        let ideas = parse_micro_app_ideas(data.as_str());

        // add each idea as a gem
        gems.update(|gems| {
            for idea in ideas {
                let id = Uuid::new_v4().to_string();
                let derived_from = selection.get();
                insert(
                    id.clone(),
                    DataGem {
                        classification: None,
                        description: idea.spec.clone(),
                        json_data: idea.view_model.clone(),
                        derived_from,
                    },
                    gems,
                );
            }
        });
    };

    let on_delete = move |id| {
        gems.update(|gems| delete(id, gems));
    };

    let select_random_gems = move || {
        let mut rng = thread_rng();
        let gem_ids: Vec<String> = gems.get().keys().cloned().collect();
        let num_to_select = rng.gen_range(2..=3.min(gem_ids.len()));
        let selected: Vec<String> = gem_ids.choose_multiple(&mut rng, num_to_select).cloned().collect();
        set_selection.set(selected);
    };

    let feeling_lucky = move |_| {
        select_random_gems();
        combine_data.dispatch(());
    };

    view! {
        <div class="app"><div>
        <div>
        <button on:click=move |_| gems.update(|gems| gems.clear())>"Clear"</button>
        <button on:click=move |_| gems.update(|gems|  {
            let id = Uuid::new_v4().to_string();
            gems.insert(
                id,
                DataGem {
                    classification: Some(ClassificationData {
                        title: "Test".to_string(),
                        content_type: "Test".to_string(),
                        emoji: "❓".to_string(),
                        sensitivity: "Test".to_string(),
                    }),
                    description: "Test".to_string(),
                    json_data: "{}".to_string(),
                    derived_from: Vec::new(),
                });
        })>
            "Add Gem"
        </button>
        </div>
        <div class="gem-dock">

        {move || gems()
            .into_iter()
            .map(|(id, gem)| view! {
                <DataGemEditor
                    id=id.to_string()
                    gem=gem
                    selected=selection.get().contains(&id)
                    on_classify=on_classify
                    on_toggle=on_toggle_selection
                    on_delete=on_delete
                /> 
            })
            .collect_view()}
        </div>
        </div>
            <div>
                <div class="gem-list">
                    { move || selection
                        .get()
                        .iter()
                        .map(|id| view! { 
                            <MiniDataGemPreview gem=gems.get().get(id).unwrap().clone() />
                        })
                        .collect_view()
                    }
                </div>
                <input type="text" placeholder="Search" on:input=move |e| search.set(event_target_value(&e)) prop:value=search></input>
                <button on:click=move |_| combine_data.dispatch(())>"Imagine"</button>
                <button on:click=feeling_lucky>"I'm feeling lucky"</button>
                <select on:change=move |e| set_llm_model.set(event_target_value(&e)) prop:value=llm_model>
                    <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
                    <option value="gpt-4o-mini">GPT-4o Mini</option>
                    <option value="llama3-405b-instruct-maas">Llama 3.1 405B</option>
                    <option value="gpt-4o">GPT-4o</option>
                    <option value="claude-3-opus-20240229">Claude 3 Opus</option>
                    <option value="claude-3-haiku-20240307">Claude 3 Haiku</option>
                </select>
                <code>{move || llm_model.get()}</code>
                
                <MicroAppGrid
                    input={imagined_apps}
                    on_save=on_save
                    on_implement=move |app_spec| {
                        spawn_local(async move {
                            match llm::implement_app(app_spec, llm_model.get()).await {
                                Ok(LlmResponse { output, .. }) => {
                                    set_implemented_apps.set(output);
                                }
                                Err(e) => {
                                    log!("Error implementing app: {:?}", e);
                                }
                            }
                        });
                    }
                    implemented_apps={implemented_apps}
                ></MicroAppGrid>
            </div>
        </div>
    }
}
