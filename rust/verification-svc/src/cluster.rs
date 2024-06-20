use anyhow::{anyhow, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use yaml_rust2::YamlLoader;

fn check_path_exists(path: &Path) -> Result<()> {
    match path.exists() {
        true => Ok(()),
        false => Err(anyhow!("{} could not be found.", path.to_string_lossy())),
    }
}

/// Represents stored measurements for a cluster by origin.
#[derive(Clone)]
pub struct ClusterMeasurements {
    measurements_dir: PathBuf,
    origin: String,
}

impl ClusterMeasurements {
    pub fn measurements_dir(&self) -> &Path {
        &self.measurements_dir
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Verify cluster against stored measurements.
    pub fn verify(&self) -> Result<bool> {
        //pub fn verify(cluster_url: &Url, cluster_id: &str) -> Result<bool> {
        let output = Command::new("constellation")
            .current_dir(&self.measurements_dir)
            .arg("verify")
            //.arg("-e")
            //.arg(cluster_url.as_str())
            //.arg("--cluster-id")
            //.arg(cluster_id)
            .output()?;
        Ok(output.status.success())
    }
}

impl TryFrom<&Path> for ClusterMeasurements {
    type Error = anyhow::Error;
    fn try_from(measurements_dir: &Path) -> std::result::Result<Self, Self::Error> {
        let state_path = measurements_dir.join("constellation-state.yaml");
        let conf_path = measurements_dir.join("constellation-conf.yaml");
        check_path_exists(&state_path)?;
        check_path_exists(&conf_path)?;

        let state_yaml = YamlLoader::load_from_str(&fs::read_to_string(&state_path)?)?;
        let endpoint_yaml = &state_yaml[0]["infrastructure"]["clusterEndpoint"];
        if endpoint_yaml.is_badvalue() {
            return Err(anyhow!(
                "constellation-conf.yaml does not contain cluster endpoint."
            ));
        }
        let origin = endpoint_yaml
            .as_str()
            .ok_or_else(|| anyhow!("constellation-conf.yaml cluster endpoint is not a string."))?;

        Ok(ClusterMeasurements {
            origin: origin.to_owned(),
            measurements_dir: measurements_dir.to_owned(),
        })
    }
}
