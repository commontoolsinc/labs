use async_trait::async_trait;
use bytes::Bytes;
use tempfile::TempDir;
use tokio::{process::Command, task::JoinSet};

use crate::{write_file, Bake};

#[derive(Debug)]
pub struct PythonBaker {}

#[async_trait]
impl Bake for PythonBaker {
    #[instrument]
    async fn bake(
        &self,
        world: &str,
        wit: Vec<Bytes>,
        source_code: Bytes,
        library: Vec<Bytes>,
    ) -> Result<Bytes, crate::UsubaError> {
        let workspace = TempDir::new()?;
        debug!(
            "Created temporary workspace in {}",
            workspace.path().display()
        );

        let wasm_path = workspace.path().join("module.wasm");
        let python_path = workspace.path().join("module.py");

        debug!(?workspace, "Created temporary workspace");

        let wit_path = workspace.path().join("wit");
        let wit_deps_path = wit_path.join("deps");

        tokio::fs::create_dir_all(&wit_deps_path).await?;

        let mut writes = JoinSet::new();

        wit.into_iter()
            .enumerate()
            .map(|(i, wit)| write_file(wit_path.join(format!("module{}.wit", i)), wit))
            .chain([write_file(python_path.clone(), source_code)])
            .chain(
                library.into_iter().enumerate().map(|(i, wit)| {
                    write_file(wit_deps_path.join(format!("library{}.wit", i)), wit)
                }),
            )
            .for_each(|fut| {
                writes.spawn(fut);
            });

        while let Some(result) = writes.try_join_next() {
            result??;
            continue;
        }

        debug!(?workspace, "Populated temporary input files");

        let mut command = Command::new("componentize-py");

        command
            .current_dir(workspace.path())
            .arg("-d")
            .arg(wit_path)
            .arg("-w")
            .arg(world)
            .arg("componentize")
            .arg("-p")
            .arg(workspace.path().display().to_string())
            .arg("-o")
            .arg("module.wasm")
            .arg("module");

        let child = command.spawn()?;
        let output = child.wait_with_output().await?;

        if output.stderr.len() > 0 {
            warn!("{}", String::from_utf8_lossy(&output.stderr));
        }

        debug!("Finished building with componentize-py");

        let wasm_bytes = tokio::fs::read(&wasm_path).await?;

        info!("Finished baking");

        Ok(wasm_bytes.into())
    }
}
