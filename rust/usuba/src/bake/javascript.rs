use std::io::Cursor;
use std::path::{Path, PathBuf};
use tracing::instrument;

use crate::UsubaError;

use super::Bake;
use async_trait::async_trait;
use bytes::Bytes;
use tempfile::TempDir;

use tokio::process::Command;
use tokio::task::JoinSet;

use wit_parser::UnresolvedPackage;

async fn write_file(path: PathBuf, bytes: Bytes) -> Result<(), UsubaError> {
    let mut file = tokio::fs::File::create(&path).await?;
    let mut cursor = Cursor::new(bytes.as_ref());
    tokio::io::copy(&mut cursor, &mut file).await?;
    Ok(())
}

#[derive(Debug)]
pub struct JavaScriptBaker {}

#[async_trait]
impl Bake for JavaScriptBaker {
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
        let js_path = workspace.path().join("module.js");

        debug!(?workspace, "Created temporary workspace");

        let wit_path = workspace.path().join("wit");
        let wit_deps_path = wit_path.join("deps");

        tokio::fs::create_dir_all(&wit_deps_path).await?;

        let mut writes = JoinSet::new();

        wit.into_iter()
            .enumerate()
            .map(|(i, wit)| write_file(wit_path.join(format!("module{}.wit", i)), wit))
            .chain([write_file(js_path.clone(), source_code)])
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

        let mut command = Command::new("jco");

        command
            .arg("componentize")
            .arg("-w")
            .arg(wit_path)
            .arg("-o")
            .arg(wasm_path.display().to_string())
            .arg(js_path.display().to_string());

        let child = command.spawn()?;
        let output = child.wait_with_output().await?;

        if output.stderr.len() > 0 {
            warn!("{}", String::from_utf8_lossy(&output.stderr));
        }

        debug!("Finished building with jco");

        let wasm_bytes = tokio::fs::read(&wasm_path).await?;

        info!("Finished baking");

        Ok(wasm_bytes.into())
    }
}
