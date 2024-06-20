use axum::{
    extract::{Json, State},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::{error::VerificationError, server::ServerState};

/// Currently, the request is "hard coded" based on
/// the constellation configuration directory given
/// on startup.
#[derive(Deserialize)]
pub struct VerificationRequest {
    origin: String,
    //   cluster_id: String,
}

#[derive(Copy, Clone, Deserialize, Serialize)]
pub struct VerificationResponse {
    pub success: bool,
}

impl From<bool> for VerificationResponse {
    fn from(value: bool) -> Self {
        VerificationResponse { success: value }
    }
}

impl IntoResponse for VerificationResponse {
    fn into_response(self) -> axum::response::Response {
        Json(self).into_response()
    }
}

pub async fn verify(
    State(state): State<ServerState>,
    Json(payload): Json<VerificationRequest>,
) -> Result<VerificationResponse, VerificationError> {
    let cluster = state
        .get_measurements(&payload.origin)
        .ok_or_else(|| VerificationError::UnknownOrigin(payload.origin.to_owned()))?;

    Ok(cluster.verify()?.into())
}
