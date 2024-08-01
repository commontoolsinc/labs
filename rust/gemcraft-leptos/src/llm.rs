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
    pub model: Option<String>,
}

async fn send_llm_request(body: CreateThreadRequest) -> Result<LlmResponse, JsValue> {
    let win = window();
    let mut opts = RequestInit::new();
    opts.method("POST");

    let body = serde_json::to_string(&body)
        .map_err(|_| JsValue::from_str("Failed to serialize JSON"))?;
    opts.body(Some(&JsValue::from_str(&body)));

    let request = Request::new_with_str_and_init(LLM_URL, &opts)?;
    let json = send_request(&win, request).await?;

    serde_wasm_bindgen::from_value(json)
        .map_err(|_| JsValue::from_str("Failed to deserialize JSON"))
}

fn extract_json_from_response(llm_response: &LlmResponse) -> Result<String, JsValue> {
    let blocks = extract_code_blocks_from_markdown(&llm_response.output, "json");
    blocks.first()
        .cloned()
        .ok_or_else(|| JsValue::from_str("No JSON blocks found in response"))
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
    let msg = format!(
        "Classify the following data:\n\n{}\n\nContext:\n\n{}",
        json, description
    );

    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Examine the provided raw data and context and return a brief title, it's confidentiality/sensitivity (public, shared, personal, secret), the data type and emoji to describe the data. Respond with a JSON object containing the title and emoji, e.g. ```json\n{\"title\": \"Personal Budget\", \"contentType\": \"Spreadsheet\", \"emoji\": \"💸\", \"sensitivity\": \"personal/financial\"}``` wrapped in a block e.g. ```json\n{}\n```."),
        message: msg,
        model: None,
    };

    let llm_response = send_llm_request(body).await?;
    log!("Response: {:?}", llm_response);

    let data = extract_json_from_response(&llm_response)?;

    serde_json::from_str(&data)
        .map_err(|_| JsValue::from_str("Failed to deserialize ClassificationData"))
}

pub async fn hallucinate_data(description: String) -> Result<String, JsValue> {
    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("imagine realistic JSON data based on the user request, respond with only JSON wrapped in a block e.g. ```json\n{}\n```."),
        message: description,
        model: None,
    };

    let llm_response = send_llm_request(body).await?;
    extract_json_from_response(&llm_response)
}

pub async fn explode_data(json: String) -> Result<String, JsValue> {
    let msg = format!("Explode the following JSON object into subcomponents:\n\njson```{}```", json);

    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Break down the provided JSON object into a list of smaller, logically related JSON objects. Each subcomponent should represent a meaningful part of the original data. Respond with only JSON wrapped in a block e.g. ```json\n[]\n```."),
        message: msg,
        model: None,
    };

    let llm_response = send_llm_request(body).await?;
    extract_json_from_response(&llm_response)
}

pub async fn make_variations(json: String, description: String) -> Result<String, JsValue> {
    let msg = format!("Create variations of the following data:\n\nJSON: {}\n\nDescription: {}", json, description);

    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Create three variations of the provided data that are 'one step away' in idea space from the original. Each variation should be a complete JSON object. Respond with only JSON wrapped in a block e.g. ```json\n[{\"variation1\":{}},{\"variation2\":{}},{\"variation3\":{}}]\n```."),
        message: msg,
        model: None,
    };

    let llm_response = send_llm_request(body).await?;
    extract_json_from_response(&llm_response)
}

pub async fn decompose_data(json: String) -> Result<String, JsValue> {
    let msg = format!("Decompose the following JSON object:\n\n{}", json);

    let body = CreateThreadRequest {
        action: String::from("create"),
        system: String::from("Analyze the provided JSON object and identify regions within it that could be extracted to variables. These are typically embedded pieces of data that are statically defined but could be made dynamic. Return a JSON object containing two properties: 'templated' (the original object with {{mustache}} style placeholders replacing the extracted regions) and 'extracted' (an object containing the extracted regions as key-value pairs). Respond with only JSON wrapped in a block e.g. ```json\n{\"templated\": {}, \"extracted\": {}}\n```."),
        message: msg,
        model: None,
    };

    let llm_response = send_llm_request(body).await?;
    extract_json_from_response(&llm_response)
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
    log!("Gems: {:?}, model: {:?}", gems, model);
    let msg = format!("Imagine a micro-app that could operate on the following data gems: \n\n{}\n\nRemember, we are creating micro-apps that literally operate ON the provided data as their input. Inspired by: {}", gems.iter().map(|g| format_gem_with_classification(g.clone())).collect::<Vec<String>>().join("\n\n"), description);
    let system = String::from("Examine the provided data gems and imagine what kind of user interface / mini-app a user would like to use to explore, manipulate and interact with the data contained within.
    You must utilize all provided data gems and consider how to use them TOGETHER in an app.
    You should create a view model based on the source data + app concept. Describe each micro-app within a <micro-app-idea> tag with a small spec listing what a user can do with a loose idea of the visual components and layout.
    
    Include a single emoji as the icon and the code for an <svg> showing a rough wireframe sketch of how the interface could look as well as the full data-model within <view-model> tags.
    
    Be creative in how you combine the input data and request, try to delight the user.
    
    You must respond in clear sections:
    
    <micro-app-idea>
    <name></name>
    <tagline></tagline
    <icon></icon>
    <spec></spec>
    <view-model></view-model>
    <sketch><svg ...></svg></sketch>
    </micro-app-idea>");

    let body = json!({
        "action": String::from("create"),
        "message": msg,
        "model": model,
        "system": system,
    });
    log!("Body: {:?}", body);

    let llm_response = send_llm_request(serde_json::from_value(body).unwrap()).await?;
    log!("Response: {:?}", llm_response);

    Ok(llm_response)
}

pub async fn implement_app(app_idea: String, model: String) -> Result<LlmResponse, JsValue> {
    log!("Implementing app: {:?}, model: {:?}", app_idea, model);

    let system_prompt = include_str!("./implement_app_prompt.md");

    let msg = format!("Implement the following micro-app idea: \n\n{}", app_idea);

    let body = json!({
        "action": String::from("create"),
        "message": msg,
        "model": model,
        "system": system_prompt,
    });
    log!("Body: {:?}", body);

    let llm_response = send_llm_request(serde_json::from_value(body).unwrap()).await?;
    log!("Response: {:?}", llm_response);

    Ok(llm_response)
}
