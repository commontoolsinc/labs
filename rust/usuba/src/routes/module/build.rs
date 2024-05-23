use std::path::PathBuf;

use axum::{
    extract::{Multipart, State},
    response::IntoResponse,
    Json,
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{Bake, Baker, HashStorage, UsubaError, UsubaState};

#[derive(ToSchema)]
pub struct BuildModuleRequest {
    pub files: Vec<Vec<u8>>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BuildModuleResponse {
    id: String,
}

impl IntoResponse for BuildModuleResponse {
    fn into_response(self) -> axum::response::Response {
        Json(self).into_response()
    }
}

#[utoipa::path(
  post,
  path = "/api/v0/module",
  request_body(content = BuildModuleRequest, content_type = "multipart/form-data"),
  responses(
    (status = 200, description = "Successfully built the module", body = BuildModuleResponse),
    (status = 400, description = "Bad request body", body = ErrorResponse),
    (status = 500, description = "Internal error", body = ErrorResponse)
  )
)]
pub async fn build_module(
    State(UsubaState { mut storage }): State<UsubaState>,
    mut form_data: Multipart,
) -> Result<BuildModuleResponse, UsubaError> {
    let mut wit: Option<Bytes> = None;
    let mut source_code: Option<Bytes> = None;
    let mut baker: Option<Baker> = None;

    'collect_files: while let Some(field) = form_data.next_field().await? {
        if let Some(file_name) = field.file_name() {
            let file_name = PathBuf::from(file_name);

            if let Some(extension) = file_name.extension() {
                match extension.to_str() {
                    Some("wit") => {
                        wit = Some(field.bytes().await?);
                    }
                    Some("js") => {
                        source_code = Some(field.bytes().await?);
                        baker = Some(Baker::JavaScript);
                    }
                    _ => (),
                };
            }
        }

        match (&wit, &source_code, &baker) {
            (Some(_), Some(_), Some(_)) => break 'collect_files,
            _ => (),
        }
    }

    if let (Some(wit), Some(source_code), Some(baker)) = (wit, source_code, baker) {
        let wasm = baker.bake(wit, source_code).await?;
        let hash = storage.write(wasm).await?;

        Ok(BuildModuleResponse {
            id: hash.to_string(),
        })
    } else {
        Err(UsubaError::BadRequest)
    }
}
