use axum::{
    extract::{Request, State},
    http::Uri,
    response::IntoResponse,
};

use crate::{UsubaError, UsubaState};

pub async fn local_inference_proxy(
    uri: Uri,
    State(UsubaState {
        client, upstream, ..
    }): State<UsubaState>,
    mut request: Request,
) -> Result<impl IntoResponse, UsubaError> {
    match upstream {
        Some(upstream) => {
            let path = uri.path().trim_start_matches("/api/v0/llm/").to_string();

            *request.uri_mut() = Uri::try_from(format!(
                "{}://{}/{}",
                upstream
                    .scheme()
                    .map(|scheme| scheme.as_str())
                    .unwrap_or("http"),
                upstream
                    .authority()
                    .map(|authority| authority.as_str())
                    .unwrap_or("localhost:8000"),
                path
            ))?;

            info!("MAKING REQUEST TO: {}", request.uri());

            client
                .request(request)
                .await
                .map(|response| response.into_response())
                .map_err(|error| UsubaError::from(error))
        }
        _ => Err(UsubaError::UpstreamError("No upstream configured".into())),
    }
}
