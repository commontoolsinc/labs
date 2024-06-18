use std::collections::BTreeMap;

use axum::{response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{InputOutput, UsubaError, Value};

use super::JsonValue;

#[derive(ToSchema, Serialize, Deserialize)]
pub struct EvalRecipeRequest {
    pub content_type: String,
    pub source_code: String,
    pub inputs: BTreeMap<String, JsonValue>,
}

#[derive(ToSchema, Serialize, Deserialize)]
pub struct EvalRecipeResponse {
    pub outputs: BTreeMap<String, JsonValue>,
}

impl IntoResponse for EvalRecipeResponse {
    fn into_response(self) -> axum::response::Response {
        Json(self).into_response()
    }
}

#[derive(Debug, Clone)]
pub struct ApiInputOutput {
    inputs: BTreeMap<String, JsonValue>,
    outputs: BTreeMap<String, JsonValue>,
}

impl ApiInputOutput {
    pub fn new(inputs: BTreeMap<String, JsonValue>) -> Self {
        Self {
            inputs,
            outputs: BTreeMap::new(),
        }
    }

    pub fn take_outputs(self) -> BTreeMap<String, JsonValue> {
        self.outputs
    }
}

impl InputOutput for ApiInputOutput {
    fn read(&self, key: &str) -> Option<Value> {
        let value = if let Some(value) = self.inputs.get(key) {
            value
        } else {
            return None;
        };

        Value::try_from(value.clone()).ok()
    }

    fn write(&mut self, key: &str, value: Value) {
        if let Some(value) = JsonValue::try_from(value).ok() {
            self.outputs.insert(key.into(), value);
        }
    }
}

use crate::Runtime;

#[utoipa::path(
  post,
  path = "/api/v0/recipe/eval",
  request_body(content = EvalRecipeRequest, content_type = "application/json"),
  responses(
    (status = 200, description = "Successfully eval'd the recipe", body = EvalRecipeResponse, content_type = "application/json"),
    (status = 400, description = "Bad request body", body = ErrorResponse),
    (status = 500, description = "Internal error", body = ErrorResponse)
  )
)]
pub async fn eval_recipe(
    Json(EvalRecipeRequest {
        content_type,
        source_code,
        inputs,
    }): Json<EvalRecipeRequest>,
) -> Result<EvalRecipeResponse, UsubaError> {
    let mut runtime = Runtime {};
    let io = runtime
        .eval(content_type, source_code, ApiInputOutput::new(inputs))
        .await?;

    Ok(EvalRecipeResponse {
        outputs: io.take_outputs(),
    })
}
