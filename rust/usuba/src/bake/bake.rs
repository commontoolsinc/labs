use crate::UsubaError;
use async_trait::async_trait;
use bytes::Bytes;

#[async_trait]
pub trait Bake {
    async fn bake(&self, wit: Bytes, source_code: Bytes) -> Result<Bytes, UsubaError>;
}
