use leptos::*;
use logging::log;
use anyhow::{Context, Error, Result};
use serde::{Deserialize, Serialize};
use serde_wasm_bindgen;
use serde_json::json;
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

pub fn build_classify_request(json: String, description: String) -> Result<Request, JsValue> {
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!(
        "Classify the following data:\n\n{}\n\nContext:\n\n{}",
        json, description
    );

    // set body as JSON string
    let body = json!({
        "action": String::from("create"),
        "system": String::from("Examine the provided raw data and context and return a brief title, it's confidentiality/sensitivity (public, shared, personal, secret), the data type and emoji to describe the data. Respond with a JSON object containing the title and emoji, e.g. ```json\n{\"title\": \"Personal Budget\", \"contentType\": \"Spreadsheet\", \"emoji\": \"💸\", \"sensitivity\": \"personal/financial\"}``` wrapped in a block e.g. ```json\n{}\n```."),
        "message": msg,
        "model": "gpt-4o-mini"
    });
    let body = serde_json::to_string(&body).unwrap();
    opts.body(Some(&JsValue::from_str(&body)));

    Request::new_with_str_and_init(LLM_URL, &opts)
}

pub async fn send_request(window: &web_sys::Window, request: Request) -> Result<JsValue, JsValue> {
    let resp = JsFuture::from(window.fetch_with_request(&request))
        .await?;

    let resp: Response = resp.dyn_into()?;

    let json = JsFuture::from(resp.json()?)
        .await?;

    Ok(json)
}

pub async fn classify_data(
    json: String,
    description: String,
) -> Result<ClassificationData, JsValue> {
    let win = window();
    
    let request = build_classify_request(json, description)?;
    let json = send_request(&win, request).await?;

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json)
        .map_err(|_| "Failed to deserialize JSON")?;

    log!("Response: {:?}", llm_response);

    let blocks = extract_code_blocks_from_markdown(&llm_response.output, "json");
    let data = blocks
        .first()
        .ok_or("No blocks")?;

    let classification_data: ClassificationData =
        serde_json::from_str(data.clone().as_str())
            .map_err(|_| "Failed to deserialize ClassificationData")?;

    Ok(classification_data)
}

pub async fn hallucinate_data(description: String) -> Result<String, JsValue> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!("{}", description);

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("imagine realistic JSON data based on the user request, respond with only JSON wrapped in a block e.g. ```json\n{}\n```."),
        message: msg,
    };
    let body = serde_json::to_string(&body)
        .map_err(|_| "Failed to serialize JSON")?;
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts)?;

    let json = send_request(&win, request).await?;

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json).map_err(|_| "Failed to deserialize JSON")?;
    let blocks = extract_code_blocks_from_markdown(&llm_response.output, "json");
    let data = blocks
        .first()
        .ok_or("No blocks")?;

    Ok(data.clone())
}

pub async fn explode_data(json: String) -> Result<String, JsValue> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!("Explode the following JSON object into subcomponents:\n\n{}", json);

    // set body as JSON string
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Break down the provided JSON object into a list of smaller, logically related JSON objects. Each subcomponent should represent a meaningful part of the original data. Respond with only JSON wrapped in a block e.g. ```json\n[]\n```."),
        message: msg,
    };
    let body = serde_json::to_string(&body)
        .map_err(|_| "Failed to serialize JSON")?;
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts)?;

    let json = send_request(&win, request).await?;

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json).map_err(|_| "Failed to deserialize JSON")?;
    let blocks = extract_code_blocks_from_markdown(&llm_response.output, "json");
    let data = blocks
        .first()
        .ok_or("No blocks")?;

    Ok(data.clone())
}

pub fn format_gem_with_classification(gem: DataGem) -> String {
    return format!(
        "<gem><description>{}</description><json>{}</json><classification>{:?}</classification></gem>",
        gem.json_data,
        gem.description,
        gem.classification
    );
}

pub async fn combine_data(gems: Vec<DataGem>, description: String, model: String) -> Result<LlmResponse, JsValue> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let msg = format!("Imagine a micro-app that could operate on the following data gems: \n\n{}\n\nRemember, we are creating micro-apps that literally operate ON the provided data as their input. Inspired by: {}", gems.iter().map(|g| format_gem_with_classification(g.clone())).collect::<Vec<String>>().join("\n\n"), description);

    // set body as JSON string
    let body = json!({
        "action": String::from("create"),
        "system": String::from("Examine the provided data gems and imagine what kind of user interface / mini-app a user would like to use to explore, manipulate and interact with the data contained within. You must utilize all provided data gems and consider how to use them TOGETHER in an app. You should create a view model based on the source data + app concept. Describe each micro-app within a <micro-app-idea> tag with a small spec listing what a user can do with a loose idea of the visual components and layout. Include an emoji as the icon and the code for an <svg> showing a rough wireframe sketch of how the interface could look as well as the full data-model within <view-model> tags. Be creative in how you combine the input data and request, try to delight the user. You must respond in clear sections <micro-app-idea><title></title><emoji></emoji><spec></spec><view-model></view-model><svg></svg></micro-app-idea>"),
        "message": msg,
        "model": model.clone(),
    });
    let body = serde_json::to_string(&body).unwrap();
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts).unwrap();

    let json = send_request(&win, request).await?;

    let llm_response: LlmResponse =
        serde_wasm_bindgen::from_value(json).map_err(|_| "Failed to deserialize JSON")?;

    log!("Response: {:?}", llm_response);

    Ok(llm_response)
}
