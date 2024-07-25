use leptos::*;
use logging::log;

use crate::{
    data::{ClassificationData, DataGem},
    llm,
};

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

    let classify_data = create_action(move |_| async move {
        let json = move || json_data.get();
        let description = move || description.get();

        let data = llm::classify_data(json(), description()).await;
        match data {
            Ok(data) => {
                on_classify((
                    id.get_value().clone(),
                    data.clone(),
                    description(),
                    json_data(),
                ));
            }
            Err(e) => {
                log!("Error: {:?}", e);
            }
        }
    });

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

    view! {
        <form class="max-w-2xl mx-auto p-4">
            <div>
                <input type="checkbox" id="selected" checked=selected on:change=move |_| on_toggle(id.get_value()) />
                {gem.classification.map(|c| view! { <DataGemPreview classification=c /> })}
            </div>

            <table>
                <tr>
                    <td>
                <label for="description" class="block mb-2 font-bold">Description</label>
                </td>
                <td>
                <textarea
                    id="description"
                    on:input=move |ev| {
                        set_description.set(event_target_value(&ev));
                    }
                    prop:value=description
                    class="w-full p-2 border rounded"
                    rows="4"
                ></textarea>
                </td>
                </tr>
                <tr>
                    <td colspan="2">
                    <button
                        type="button"
                        on:click=move |_| hallucinate_data.dispatch(())
                        class="classify"
                    >
                        "Hallucinate Data"
                    </button>
                    </td>
                </tr>
                <tr>
                <td><label for="json-editor" class="block mb-2 font-bold">JSON Editor</label></td>
                <td><textarea
                    id="json-editor"
                    on:input=move |ev| {
                        set_json_data.set(event_target_value(&ev));
                    }
                    prop:value=json_data
                    class="w-full p-2 border rounded font-mono"
                    rows="10"
                ></textarea></td>
                </tr>
                <tr>
                    <td colspan="2">
                    <button
                        type="button"
                        on:click=move |_| classify_data.dispatch(())
                        class="classify"
                    >
                        "Classify Data"
                    </button>
                    </td>
                </tr>
            </table>
        </form>
    }
}
