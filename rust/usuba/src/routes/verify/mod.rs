use axum::http::StatusCode;

#[utoipa::path(
  get,
  path = "/api/v0/verify",
  responses(
    (status = 200, description = "Successfully verified.")
  )
)]
pub async fn verify() -> StatusCode {
    StatusCode::OK
}
