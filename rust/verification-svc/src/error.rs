use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::error;

#[derive(Debug, Error)]
pub enum VerificationError {
    #[error("Bad request body")]
    BadRequest(String),
    #[error("An internal error occurred")]
    Internal(String),
}

impl From<url::ParseError> for VerificationError {
    fn from(value: url::ParseError) -> Self {
        error!("{}", value);
        VerificationError::BadRequest(format!("{}", value))
    }
}

impl From<anyhow::Error> for VerificationError {
    fn from(value: anyhow::Error) -> Self {
        error!("{}", value);
        VerificationError::Internal(format!("{}", value))
    }
}

impl IntoResponse for VerificationError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            VerificationError::BadRequest(_) => StatusCode::BAD_REQUEST,
            VerificationError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        (
            status,
            Json(ErrorResponse {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

#[derive(Serialize, Deserialize)]
pub struct ErrorResponse {
    error: String,
}
