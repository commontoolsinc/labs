use crate::UsubaError;
use async_trait::async_trait;
use bytes::Bytes;

#[async_trait]
pub trait Bake {
    async fn bake(
        &self,
        world: &str,
        wit: Vec<Bytes>,
        source_code: Bytes,
        library: Vec<Bytes>,
    ) -> Result<Bytes, UsubaError>;
}
