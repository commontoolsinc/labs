use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about, long_about = None)]
pub struct Cli {
    /// The path to the directory containing
    /// `constellation-conf.yaml` and `constellation-state.yaml`
    pub config_dir: PathBuf,

    /// Port to listen on
    #[arg(short, long, default_value_t = 30125)]
    pub port: u16,
}
