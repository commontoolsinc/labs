use std::collections::HashMap;
use uuid::Uuid;
use leptos::*;
use logging::log;
use serde::{Deserialize, Serialize};
use serde_wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

mod extract;
use extract::extract_code_blocks_from_markdown;

const LLM_URL: &str = "http://localhost:8000";

fn main() {
    console_error_panic_hook::set_once();

    mount_to_body(|| view! { <App /> })
}

// create signal to store hashmap of data gems

#[component]
fn App() -> impl IntoView {
    let gems = create_rw_signal(HashMap::<String, DataGem>::new());
    let (selection, set_selection) = create_signal(Vec::<String>::new());
    
    let on_toggle_selection = move |id| {
        set_selection.update(|current|
        if current.contains(&id) {
            current.retain(|x| x != &id);
        } else {
            current.push(id.clone());
        })
    };

    let on_classify = move |(id, classification, description, json_data)| {
        gems.update(|gems| {
            gems.insert(id, DataGem {
                classification: Some(classification),
                description: description,
                json_data: json_data,
            });
        });
    };

    view! {
        <div>
        <code>{move || selection.get().join(", ")}</code>
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
    }
}
#[derive(Deserialize, Serialize, Debug)]
struct LlmResponse {
    #[serde(rename = "type")]
    r#type: String,
    #[serde(rename = "threadId")]
    thread_id: String,
    output: String,
}

#[derive(Deserialize, Serialize, Debug)]
struct CreateThreadRequest {
    action: String,
    system: String,
    message: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ClassificationData {
    title: String,
    #[serde(rename = "contentType")]
    content_type: String,
    emoji: String,
    sensitivity: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct DataGem {
    classification: Option<ClassificationData>,
    description: String,
    json_data: String,
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

pub async fn classify_data(json: String, description: String) -> Result<ClassificationData, String> {
    let win = window();
    let mut opts = RequestInit::new();
            opts.method("POST");
    
        let msg = format!(
        "Classify the following data:\n\n{}\n\nContext:\n\n{}",
        json,
        description
    );

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Examine the provided raw data and context and return a brief title, it's confidentiality/sensitivity (public, shared, personal, secret), the data type and emoji to describe the data. Respond with a JSON object containing the title and emoji, e.g. {\"title\": \"Personal Budget\", \"contentType\": \"Spreadsheet\", \"emoji\": \"💸\", \"sensitivity\": \"personal/financial\"} wrapped in a code block."),
        message: msg,
    };
    let body = serde_json::to_string(&body).unwrap();
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts).unwrap();

    let resp_value = JsFuture::from(win.fetch_with_request(&request))
        .await
        .expect("failed to fetch");
    let resp: Response = resp_value.dyn_into().unwrap();

    let json = JsFuture::from(resp.json().unwrap())
        .await
        .expect("failed to get response text");

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json).map_err(|_| "Failed to deserialize JSON")?;

    log!("Response: {:?}", llm_response);

    let classification_data =
        extract_code_blocks_from_markdown(&llm_response.output, "json");
    let classification_data: ClassificationData =
        serde_json::from_str(&classification_data[0]).unwrap();

    Ok(classification_data)
}

pub async fn combine_data(json: String, description: String) -> Result<ClassificationData, String> {
    let win = window();
    let mut opts = RequestInit::new();
            opts.method("POST");
    
        let msg = format!(
        "Classify the following data:\n\n{}\n\nContext:\n\n{}",
        json,
        description
    );

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Examine the provided raw data and context and return a brief title, it's confidentiality/sensitivity (public, shared, personal, secret), the data type and emoji to describe the data. Respond with a JSON object containing the title and emoji, e.g. {\"title\": \"Personal Budget\", \"contentType\": \"Spreadsheet\", \"emoji\": \"💸\", \"sensitivity\": \"personal/financial\"} wrapped in a code block."),
        message: msg,
    };
    let body = serde_json::to_string(&body).unwrap();
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts).unwrap();

    let resp_value = JsFuture::from(win.fetch_with_request(&request))
        .await
        .expect("failed to fetch");
    let resp: Response = resp_value.dyn_into().unwrap();

    let json = JsFuture::from(resp.json().unwrap())
        .await
        .expect("failed to get response text");

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json).map_err(|_| "Failed to deserialize JSON")?;

    log!("Response: {:?}", llm_response);

    let classification_data =
        extract_code_blocks_from_markdown(&llm_response.output, "json");
    let classification_data: ClassificationData =
        serde_json::from_str(&classification_data[0]).unwrap();

    Ok(classification_data)
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

    let classify_data = create_action(move |_| {
        async move {
            let json = move || json_data.get();
            let description = move || description.get();

            let data = classify_data(json(), description()).await;
            match data {
                Ok(data) => {
                    on_classify((id.get_value().clone(), data.clone(), description(), json_data()));
                },
                Err(e) => {
                    log!("Error: {:?}", e);
                }
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

fn event_target_value(ev: &web_sys::Event) -> String {
    let target: web_sys::EventTarget = ev.target().unwrap();
    let target: web_sys::HtmlTextAreaElement = target.dyn_into().unwrap();
    target.value()
}
