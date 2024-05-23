use std::io::Cursor;
use tracing::instrument;

use super::Bake;
use async_trait::async_trait;
use bytes::Bytes;
use tempfile::TempDir;

use tokio::process::Command;

#[derive(Debug)]
pub struct JavaScriptBaker {}

#[async_trait]
impl Bake for JavaScriptBaker {
    #[instrument]
    async fn bake(&self, wit: Bytes, source_code: Bytes) -> Result<Bytes, crate::UsubaError> {
        let workspace = TempDir::new()?;
        debug!(
            "Created temporary workspace in {}",
            workspace.path().display()
        );

        let wasm_path = workspace.path().join("module.wasm");
        let js_path = workspace.path().join("module.js");
        let wit_path = workspace.path().join("module.wit");

        let (mut wit_file, mut js_file) = tokio::try_join!(
            tokio::fs::File::create(&wit_path),
            tokio::fs::File::create(&js_path),
        )?;

        debug!(?wit_path, ?js_path, "Created temporary input files");

        let mut wit_cursor = Cursor::new(wit);
        let mut js_cursor = Cursor::new(source_code);

        tokio::try_join!(
            tokio::io::copy(&mut wit_cursor, &mut wit_file),
            tokio::io::copy(&mut js_cursor, &mut js_file),
        )?;

        debug!(?wit_path, ?js_path, "Populated temporary input files");

        let mut command = Command::new("jco");

        command
            .arg("componentize")
            .arg("-w")
            .arg(wit_path.display().to_string())
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
