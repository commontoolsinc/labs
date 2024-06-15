#[macro_use]
extern crate tracing;

use std::net::SocketAddr;

use tracing_subscriber::{fmt::Layer, layer::SubscriberExt, EnvFilter, FmtSubscriber};
use usuba::{serve, UsubaError};

#[tokio::main]
pub async fn main() -> Result<(), UsubaError> {
    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .finish();
    tracing::subscriber::set_global_default(subscriber.with(Layer::default().pretty()))?;

    let port = std::env::var("PORT").unwrap_or("8080".into());
    let socket_address: SocketAddr = format!("0.0.0.0:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(socket_address).await?;
    let upstream = std::env::var("UPSTREAM")
        .ok()
        .map(|upstream| upstream.parse().ok())
        .unwrap_or(None);

    info!("Server listening on {}", socket_address);
    if let Some(upstream) = &upstream {
        info!("Reverse proxying requests to {}", upstream);
    }

    serve(listener, upstream).await?;

    Ok(())
}
