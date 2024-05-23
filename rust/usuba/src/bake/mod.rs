mod bake;
mod javascript;

pub use bake::*;
pub use javascript::*;

use async_trait::async_trait;
use bytes::Bytes;

pub enum Baker {
    JavaScript,
}

#[async_trait]
impl Bake for Baker {
    async fn bake(&self, wit: Bytes, source_code: Bytes) -> Result<Bytes, crate::UsubaError> {
        match self {
            Baker::JavaScript => (JavaScriptBaker {}).bake(wit, source_code).await,
        }
    }
}
