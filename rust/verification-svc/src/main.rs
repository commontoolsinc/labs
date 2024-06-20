mod cli;
mod cluster;
mod error;
mod server;

use anyhow::Result;
use clap::Parser;
use cli::Cli;
use cluster::ClusterMeasurements;
use std::{net::SocketAddr, process::Command};
use tracing_subscriber::{fmt::Layer, layer::SubscriberExt, EnvFilter, FmtSubscriber};

#[tokio::main]
pub async fn main() -> Result<()> {
    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .finish();
    tracing::subscriber::set_global_default(subscriber.with(Layer::default().pretty()))?;

    check_env()?;
    let cli = Cli::parse();
    let cluster = ClusterMeasurements::try_from(cli.config_dir.as_path())?;
    let socket_address: SocketAddr = format!("0.0.0.0:{}", cli.port).parse()?;
    let listener = tokio::net::TcpListener::bind(socket_address).await?;
    server::serve(listener, cluster).await?;
    Ok(())
}

/// Ensure necessary tools are available in the environment
/// to verify.
fn check_env() -> Result<()> {
    if !Command::new("constellation").output()?.status.success() {
        return Err(anyhow::anyhow!("`constellation` not found."));
    }
    Ok(())
}
