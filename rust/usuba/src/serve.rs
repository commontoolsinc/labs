use axum::{
    routing::{get, post},
    Router,
};
use tokio::net::TcpListener;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    error::UsubaError,
    openapi::OpenApiDocs,
    routes::{build_module, retrieve_module},
    PersistedHashStorage,
};

#[derive(Clone)]
pub struct UsubaState {
    pub storage: PersistedHashStorage,
}

pub async fn serve(listener: TcpListener) -> Result<(), UsubaError> {
    let storage = PersistedHashStorage::temporary()?;

    let app = Router::new()
        .merge(SwaggerUi::new("/swagger-ui").url("/openapi.json", OpenApiDocs::openapi()))
        .route("/api/v0/module", post(build_module))
        .route("/api/v0/module/:id", get(retrieve_module))
        .with_state(UsubaState { storage });

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
