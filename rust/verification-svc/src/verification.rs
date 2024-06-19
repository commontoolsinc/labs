use anyhow::{anyhow, Result};
use std::{path::Path, process::Command};

fn check_path_exists(path: &Path) -> Result<()> {
    match path.exists() {
        true => Ok(()),
        false => Err(anyhow!("{} could not be found.", path.to_string_lossy())),
    }
}

/// Check environment to ensure that the `constellation`
/// CLI is installed and configured correctly and there's
/// a configuration directory with the appropriate measurements.
pub fn check_env(config_dir: &Path) -> Result<()> {
    let output = Command::new("constellation").output()?;
    if !output.status.success() {
        return Err(anyhow!("`constellation` not found."));
    }
    check_path_exists(&config_dir.join("constellation-conf.yaml"))?;
    check_path_exists(&config_dir.join("constellation-state.yaml"))?;
    Ok(())
}

/// Run cluster verification on `cluster_url` and `cluster_id`.
pub fn verify(config_dir: &Path) -> Result<bool> {
    //pub fn verify(cluster_url: &Url, cluster_id: &str) -> Result<bool> {
    let output = Command::new("constellation")
        .current_dir(config_dir)
        .arg("verify")
        //.arg("-e")
        //.arg(cluster_url.as_str())
        //.arg("--cluster-id")
        //.arg(cluster_id)
        .output()?;
    Ok(output.status.success())
}
