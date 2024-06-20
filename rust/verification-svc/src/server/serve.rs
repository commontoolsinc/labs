use super::routes::verify;
use crate::cluster::ClusterMeasurements;
use anyhow::Result;
use axum::{http::Method, routing::post, Router};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[derive(Clone)]
pub struct ServerState {
    cluster: ClusterMeasurements,
}

impl ServerState {
    pub fn get_measurements(&self, origin: &str) -> Option<&ClusterMeasurements> {
        if origin == self.cluster.origin() {
            Some(&self.cluster)
        } else {
            None
        }
    }
}

impl From<ClusterMeasurements> for ServerState {
    fn from(cluster: ClusterMeasurements) -> Self {
        ServerState { cluster }
    }
}

pub async fn serve(listener: TcpListener, cluster: ClusterMeasurements) -> Result<()> {
    info!(
        "Running on {:#?} using configurations at {:#?}",
        listener.local_addr(),
        cluster.measurements_dir(),
    );
    let cors = CorsLayer::new()
        .allow_methods([Method::POST])
        .allow_origin(Any);

    let app = Router::new()
        .route("/api/v0/verify", post(verify))
        .with_state(ServerState::from(cluster))
        .layer(cors);

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
