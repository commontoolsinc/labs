use std::path::{Path, PathBuf};

use super::routes::verify;
use anyhow::Result;
use axum::{http::Method, routing::get, Router};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[derive(Clone)]
pub struct ServerState {
    config_dir: PathBuf,
}

impl ServerState {
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }
}

impl From<&Path> for ServerState {
    fn from(value: &Path) -> Self {
        ServerState {
            config_dir: value.to_owned(),
        }
    }
}

pub async fn serve(listener: TcpListener, config_dir: &Path) -> Result<()> {
    info!(
        "Running on {:#?} using configurations at {:#?}",
        listener.local_addr(),
        config_dir
    );
    let cors = CorsLayer::new()
        .allow_methods([Method::GET])
        .allow_origin(Any);

    let app = Router::new()
        .route("/api/v0/verify", get(verify))
        .with_state(ServerState::from(config_dir))
        .layer(cors);

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
