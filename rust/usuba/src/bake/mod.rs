mod bake;
mod fs;
mod javascript;
mod python;

pub use bake::*;
pub use fs::*;
pub use javascript::*;
pub use python::*;

use async_trait::async_trait;
use bytes::Bytes;

pub enum Baker {
    JavaScript,
    Python,
}

#[async_trait]
impl Bake for Baker {
    async fn bake(
        &self,
        world: &str,
        wit: Vec<Bytes>,
        source_code: Bytes,
        library: Vec<Bytes>,
    ) -> Result<Bytes, crate::UsubaError> {
        match self {
            Baker::JavaScript => {
                (JavaScriptBaker {})
                    .bake(world, wit, source_code, library)
                    .await
            }
            Baker::Python => {
                (PythonBaker {})
                    .bake(world, wit, source_code, library)
                    .await
            }
        }
    }
}
