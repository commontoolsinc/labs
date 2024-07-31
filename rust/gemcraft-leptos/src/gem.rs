use leptos::*;
use logging::log;

use crate::{
    data::{ClassificationData, DataGem},
    llm,
    toggle::ToggleContent,
};

#[derive(Clone, PartialEq)]
enum GemAction {
    Parameterize,
    Explode,
    MakeVariations,
    Classify,
}

#[component]
pub fn DataGemPreview(classification: ClassificationData) -> impl IntoView {
    view! {
        <div class="data-gem">
            <div class="icon">{classification.emoji.clone()}</div>
            <div class="content">
                <h2 class="title">{classification.title.clone()}</h2>
                <code class="content-type">{classification.content_type.clone()} "("{classification.sensitivity.clone()}")"</code>
            </div>
        </div>
    }
}

#[component]
pub fn MiniDataGemPreview(gem: DataGem) -> impl IntoView {
    view! {
        <div class="small data-gem">
            <div class="icon">{gem.classification.map(|c| c.emoji)}</div>
        </div>
    }
}

#[component]
pub fn DataGemEditor(
    id: String,
    gem: DataGem,
    selected: bool,
    #[prop(into)] on_toggle: Callback<String>,
    #[prop(into)] on_classify: Callback<(String, ClassificationData, String, String)>,
) -> impl IntoView {
    let id = store_value(id);
    let (description, set_description) = create_signal(gem.description.clone());
    let (json_data, set_json_data) = create_signal(gem.json_data.clone());
    let (selected_action, set_selected_action) = create_signal(GemAction::Classify);

    let hallucinate_data = create_action(move |_| async move {
        let description = move || description.get();

        let data = llm::hallucinate_data(description()).await;
        match data {
            Ok(data) => {
                set_json_data.set(data);
            }
            Err(e) => {
                log!("Error: {:?}", e);
            }
        }
    });

    let run_action = create_action(move |_| async move {
        match selected_action.get() {
            GemAction::Parameterize => {
                log!("Parameterize action");
                todo!("Implement parameterize action");
            }
            GemAction::Explode => {
                handle_explode_action(id.get_value(), json_data.get()).await;
            }
            GemAction::MakeVariations => {
                handle_make_variations_action(id.get_value(), json_data.get(), description.get()).await;
            }
            GemAction::Classify => {
                handle_classify_action(id.get_value(), json_data.get(), description.get(), on_classify).await;
            }
        }
    });

    async fn handle_explode_action(id: String, json_data: String) {
        match llm::explode_data(json_data).await {
            Ok(exploded_data) => {
                log!("Exploded data for gem {}: {}", id, exploded_data);
                // TODO: Handle the exploded data, e.g., update the UI or create new gems
            }
            Err(e) => {
                log!("Error exploding data for gem {}: {:?}", id, e);
            }
        }
    }

    async fn handle_classify_action(
        id: String,
        json_data: String,
        description: String,
        on_classify: Callback<(String, ClassificationData, String, String)>,
    ) {
        let data = llm::classify_data(json_data.clone(), description.clone()).await;
        match data {
            Ok(data) => {
                on_classify((id, data.clone(), description, json_data));
            }
            Err(e) => {
                log!("Error: {:?}", e);
            }
        }
    }

    async fn handle_make_variations_action(id: String, json_data: String, description: String) {
        match llm::make_variations(json_data, description).await {
            Ok(variations) => {
                log!("Variations for gem {}: {}", id, variations);
                // TODO: Handle the variations, e.g., update the UI or create new gems
            }
            Err(e) => {
                log!("Error making variations for gem {}: {:?}", id, e);
            }
        }
    }

    view! {
        <form class="gem-form">
            <div>
                <input type="checkbox" id="selected" checked=selected on:change=move |_| on_toggle(id.get_value()) />
                {gem.classification.map(|c| view! { <DataGemPreview classification=c /> })}
            </div>

            <ToggleContent>
            <table>
                <tr>
                    <td>
                <label for="description">Description</label>
                <br />
                <button
                    type="button"
                    on:click=move |_| hallucinate_data.dispatch(())
                    class="classify"
                >
                    "Hallucinate"
                </button>
                </td>
                <td>
                <textarea
                    id="description"
                    on:input=move |ev| {
                        set_description.set(event_target_value(&ev));
                    }
                    prop:value=description
                    rows="4"
                ></textarea>
                </td>
                </tr>
                <tr>
                <td colspan="2">
                <textarea
                    id="json-editor"
                    on:input=move |ev| {
                        set_json_data.set(event_target_value(&ev));
                    }
                    prop:value=json_data
                    rows="10"
                    cols="36"
                ></textarea></td>
                </tr>
                <tr>
                    <td colspan="2">
                        <div class="actions-section">
                            <select
                                on:change=move |ev| {
                                    let value = event_target_value(&ev);
                                    set_selected_action.set(match value.as_str() {
                                        "classify" => GemAction::Classify,
                                        "parameterize" => GemAction::Parameterize,
                                        "explode" => GemAction::Explode,
                                        "make-variations" => GemAction::MakeVariations,
                                        _ => GemAction::Classify,
                                    });
                                }
                            >
                                <option value="classify">"Classify"</option>
                                <option value="parameterize">"Parameterize"</option>
                                <option value="explode">"Explode"</option>
                                <option value="make-variations">"Make Variations"</option>
                            </select>
                            <button
                                type="button"
                                class="classify"
                                on:click=move |_| run_action.dispatch(())
                            >
                                "Run Action"
                            </button>
                        </div>
                    </td>
                </tr>
            </table>
            </ToggleContent>
        </form>
    }
}
