use tracing::instrument;

use super::Bake;
use async_trait::async_trait;
use bytes::Bytes;
use tempfile::TempDir;

use tokio::process::Command;
use tokio::task::JoinSet;
use usuba_bundle::JavaScriptBundler;

use crate::write_file;

#[derive(Debug)]
pub struct JavaScriptBaker {}

#[async_trait]
impl Bake for JavaScriptBaker {
    #[instrument]
    async fn bake(
        &self,
        _world: &str,
        wit: Vec<Bytes>,
        source_code: Bytes,
        library: Vec<Bytes>,
    ) -> Result<Bytes, crate::UsubaError> {
        let workspace = TempDir::new()?;
        debug!(
            "Created temporary workspace in {}",
            workspace.path().display()
        );

        let bundled_source_code = tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current()
                .block_on(JavaScriptBundler::bundle_module(source_code))
        })
        .await??;

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
            .chain([write_file(
                js_path.clone(),
                Bytes::from(bundled_source_code),
            )])
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

        Command::new("cp")
            .arg("-r")
            .arg(format!("{}", workspace.path().display()))
            .arg("/tmp/failed")
            .spawn()?
            .wait()
            .await?;

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
