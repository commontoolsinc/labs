use std::time::Duration;

use axum::{
    body::Body,
    http::{Method, Uri},
    routing::{get, post},
    Router,
};
use hyper_util::{
    client::legacy::{connect::HttpConnector, Client},
    rt::TokioExecutor,
};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    error::UsubaError,
    openapi::OpenApiDocs,
    routes::{
        build_module, bundle_javascript, eval_recipe, retrieve_module, ui_file, ui_index,
        upstream_index, verify,
    },
    PersistedHashStorage,
};

pub type HttpClient = hyper_util::client::legacy::Client<HttpConnector, Body>;

#[derive(Clone)]
pub struct UsubaState {
    pub storage: PersistedHashStorage,
    pub client: HttpClient,
    pub upstream: Option<Uri>,
}

pub async fn serve(listener: TcpListener, upstream: Option<Uri>) -> Result<(), UsubaError> {
    let storage = PersistedHashStorage::temporary()?;
    let client: HttpClient = Client::<(), ()>::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(30))
        .build_http();

    let cors = CorsLayer::new()
        .allow_methods([Method::HEAD, Method::GET, Method::POST])
        .allow_origin(Any);

    let app = Router::new()
        .merge(SwaggerUi::new("/swagger-ui").url("/openapi.json", OpenApiDocs::openapi()))
        .route("/api/v0/bundle", post(bundle_javascript))
        .route("/api/v0/module", post(build_module))
        .route("/api/v0/module/:id", get(retrieve_module))
        .route("/api/v0/recipe/eval", post(eval_recipe))
        .route("/api/v0/verify", get(verify))
        .route("/", get(ui_index))
        .route("/*file", get(ui_file))
        .with_state(UsubaState {
            storage,
            client,
            upstream,
        })
        .layer(cors);

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
