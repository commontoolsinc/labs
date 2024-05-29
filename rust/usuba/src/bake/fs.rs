use std::{io::Cursor, path::PathBuf};

use bytes::Bytes;

use crate::UsubaError;

pub async fn write_file(path: PathBuf, bytes: Bytes) -> Result<(), UsubaError> {
    let mut file = tokio::fs::File::create(&path).await?;
    let mut cursor = Cursor::new(bytes.as_ref());
    tokio::io::copy(&mut cursor, &mut file).await?;
    Ok(())
}
