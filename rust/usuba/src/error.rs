// use std::fmt::Display;

use axum::{
    extract::multipart::MultipartError,
    http::{uri::InvalidUri, StatusCode},
    response::IntoResponse,
    Json,
};
use blake3::HexError;
use redb::{CommitError, DatabaseError, StorageError, TableError, TransactionError};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::task::JoinError;
use tracing::subscriber::SetGlobalDefaultError;
use utoipa::ToSchema;

#[derive(Debug, Error)]
pub enum UsubaError {
    #[error("Bad request body")]
    BadRequest,
    #[error("Failed to bake the module: {0}")]
    BakeFailure(String),
    #[error("Invalid configuration: {0}")]
    InvalidConfiguration(String),
    #[error("Invalid module: {0}")]
    InvalidModule(String),
    #[error("Module not found")]
    ModuleNotFound,
    #[error("Upstream request failed: {0}")]
    UpstreamError(String),
    #[error("An internal error occurred")]
    Internal(String),
}

impl From<std::net::AddrParseError> for UsubaError {
    fn from(value: std::net::AddrParseError) -> Self {
        UsubaError::InvalidConfiguration(format!("{}", value))
    }
}

impl From<std::io::Error> for UsubaError {
    fn from(value: std::io::Error) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<MultipartError> for UsubaError {
    fn from(_value: MultipartError) -> Self {
        UsubaError::BadRequest
    }
}

impl From<SetGlobalDefaultError> for UsubaError {
    fn from(value: SetGlobalDefaultError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<StorageError> for UsubaError {
    fn from(value: StorageError) -> Self {
        error!("{}", value);
        UsubaError::ModuleNotFound
    }
}

impl From<TransactionError> for UsubaError {
    fn from(value: TransactionError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<TableError> for UsubaError {
    fn from(value: TableError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<CommitError> for UsubaError {
    fn from(value: CommitError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<DatabaseError> for UsubaError {
    fn from(value: DatabaseError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<HexError> for UsubaError {
    fn from(_value: HexError) -> Self {
        UsubaError::BadRequest
    }
}

impl From<JoinError> for UsubaError {
    fn from(value: JoinError) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<anyhow::Error> for UsubaError {
    fn from(value: anyhow::Error) -> Self {
        error!("{}", value);
        UsubaError::Internal(format!("{}", value))
    }
}

impl From<hyper_util::client::legacy::Error> for UsubaError {
    fn from(value: hyper_util::client::legacy::Error) -> Self {
        UsubaError::UpstreamError(format!("{}", value))
    }
}

impl From<InvalidUri> for UsubaError {
    fn from(value: InvalidUri) -> Self {
        warn!("{}", value);
        UsubaError::BadRequest
    }
}

impl IntoResponse for UsubaError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            UsubaError::BadRequest => StatusCode::BAD_REQUEST,
            UsubaError::InvalidModule(_) => StatusCode::BAD_REQUEST,
            UsubaError::BakeFailure(_) => StatusCode::INTERNAL_SERVER_ERROR,
            UsubaError::InvalidConfiguration(_) => StatusCode::BAD_REQUEST,
            UsubaError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            UsubaError::ModuleNotFound => StatusCode::NOT_FOUND,
            UsubaError::UpstreamError(_) => StatusCode::BAD_GATEWAY,
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

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ErrorResponse {
    error: String,
}
