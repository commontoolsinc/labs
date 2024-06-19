mod cli;
mod error;
mod server;
mod verification;

use anyhow::Result;
use clap::Parser;
use cli::Cli;
use std::net::SocketAddr;
use tracing_subscriber::{fmt::Layer, layer::SubscriberExt, EnvFilter, FmtSubscriber};

#[tokio::main]
pub async fn main() -> Result<()> {
    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .finish();
    tracing::subscriber::set_global_default(subscriber.with(Layer::default().pretty()))?;

    let cli = Cli::parse();
    verification::check_env(&cli.config_dir)?;

    let socket_address: SocketAddr = format!("0.0.0.0:{}", cli.port).parse()?;
    let listener = tokio::net::TcpListener::bind(socket_address).await?;
    server::serve(listener, &cli.config_dir).await?;
    Ok(())
}
