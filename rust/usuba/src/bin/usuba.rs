#[macro_use]
extern crate tracing;

use std::net::SocketAddr;

use tracing::Level;
use tracing_subscriber::{fmt::Layer, layer::SubscriberExt, FmtSubscriber};
use usuba::{serve, UsubaError};

#[tokio::main]
pub async fn main() -> Result<(), UsubaError> {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::TRACE)
        .finish();
    tracing::subscriber::set_global_default(subscriber.with(Layer::default().pretty()))?;

    let port = std::option_env!("PORT").unwrap_or("8080");
    let socket_address: SocketAddr = format!("0.0.0.0:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(socket_address).await?;

    info!("Server listening on {}", socket_address);

    serve(listener).await?;

    Ok(())
}
