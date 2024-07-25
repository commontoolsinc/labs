use leptos::*;
use logging::log;
use serde::{Deserialize, Serialize};
use serde_wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

use crate::{
    data::{ClassificationData, DataGem},
    extract::extract_code_blocks_from_markdown,
};

const LLM_URL: &str = "http://localhost:8000";

#[derive(Deserialize, Serialize, Debug)]
pub struct LlmResponse {
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub output: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct CreateThreadRequest {
    pub action: String,
    pub system: String,
    pub message: String,
}

pub async fn classify_data(
    json: String,
    description: String,
) -> Result<ClassificationData, String> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!(
        "Classify the following data:\n\n{}\n\nContext:\n\n{}",
        json, description
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

    let classification_data = extract_code_blocks_from_markdown(&llm_response.output, "json");
    let classification_data: ClassificationData =
        serde_json::from_str(&classification_data[0]).unwrap();

    Ok(classification_data)
}

pub async fn hallucinate_data(description: String) -> Result<String, String> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!("{}", description);

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("imagine realistic JSON data based on the user request, respond with only JSON in a code block."),
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
    let data = extract_code_blocks_from_markdown(&llm_response.output, "json");

    log!("Response: {:?}", llm_response);

    Ok(data[0].clone())
}

pub fn format_gem_with_classification(gem: DataGem) -> String {
    return format!(
        "<gem><description>{}</description><json>{}</json><classification>{:?}</classification></gem>",
        gem.json_data,
        gem.description,
        gem.classification
    );
}

pub async fn combine_data(gems: Vec<DataGem>, description: String) -> Result<LlmResponse, String> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!("Imagine 4 different micro-apps that could operate on the following data gems: \n\n{}\n\nContext:\n\n{}\n\nRemember, we are creating micro-apps that literally operate ON the provided data as their input.", gems.iter().map(|g| format_gem_with_classification(g.clone())).collect::<Vec<String>>().join("\n\n"), description);

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Examine the provided data gems and imagine what kind of user interface / mini-app a user would like to use to explore, manipulate and interact with the data contained within. Describe each micro-app with a small spec listing what a user can do with a loose idea of the visual components and layout. Include an emoji as the icon."),
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

    Ok(llm_response)
}
