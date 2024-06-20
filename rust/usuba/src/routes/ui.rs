use axum::{
    extract::{Request, State},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;

use crate::{UsubaError, UsubaState};

#[derive(Embed)]
#[folder = "../../typescript/packages/lookslike-prototype/dist"]
struct Asset;

pub struct StaticFile<T>(pub T);

impl<T> IntoResponse for StaticFile<T>
where
    T: Into<String>,
{
    fn into_response(self) -> Response {
        let path = self.0.into();

        match Asset::get(path.as_str()) {
            Some(content) => {
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
            }
            None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
        }
    }
}

pub async fn ui_file(
    uri: Uri,
    State(UsubaState {
        client, upstream, ..
    }): State<UsubaState>,
    mut request: Request,
) -> Result<impl IntoResponse, UsubaError> {
    let path = uri.path().trim_start_matches('/').to_string();
    let ui_response = StaticFile(path.clone()).into_response();

    match (ui_response.status(), upstream) {
        (StatusCode::NOT_FOUND, Some(upstream)) => {
            *request.uri_mut() = Uri::try_from(format!(
                "{}://{}/{}",
                upstream
                    .scheme()
                    .map(|scheme| scheme.as_str())
                    .unwrap_or("http"),
                upstream
                    .authority()
                    .map(|authority| authority.as_str())
                    .unwrap_or("localhost"),
                path
            ))?;

            client
                .request(request)
                .await
                .map(|response| response.into_response())
                .map_err(|error| UsubaError::from(error))
        }
        _ => Ok(ui_response),
    }
}

pub async fn upstream_index(state: State<UsubaState>, request: Request) -> impl IntoResponse {
    ui_file("/index.html".parse::<Uri>().unwrap(), state, request).await
}

pub async fn ui_index(state: State<UsubaState>, request: Request) -> impl IntoResponse {
    ui_file("/index.html".parse::<Uri>().unwrap(), state, request).await
}
