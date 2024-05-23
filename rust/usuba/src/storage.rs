use std::sync::Arc;

use async_trait::async_trait;
use blake3::Hash;
use bytes::Bytes;
use redb::{Database, TableDefinition};
use tempfile::NamedTempFile;

use crate::UsubaError;

#[async_trait]
pub trait HashStorage: Send + Sync {
    async fn read(&self, key: &Hash) -> Result<Option<Bytes>, UsubaError>;
    async fn write(&mut self, value: Bytes) -> Result<Hash, UsubaError>;
}

const MODULE_TABLE: TableDefinition<&str, Vec<u8>> = TableDefinition::new("modules");

#[derive(Clone)]
pub struct PersistedHashStorage {
    db: Arc<Database>,
    _temp_file: Option<Arc<NamedTempFile>>,
}

impl PersistedHashStorage {
    pub fn temporary() -> Result<Self, UsubaError> {
        let temp_file = Arc::new(NamedTempFile::new()?);
        let db = Arc::new(Database::create(temp_file.path())?);

        Ok(Self {
            db,
            _temp_file: Some(temp_file),
        })
    }
}

#[async_trait]
impl HashStorage for PersistedHashStorage {
    async fn read(&self, key: &Hash) -> Result<Option<Bytes>, UsubaError> {
        let tx = self.db.begin_read()?;
        let table = tx.open_table(MODULE_TABLE)?;

        Ok(table
            .get(key.to_string().as_str())?
            .map(|v| v.value().into()))
    }

    async fn write(&mut self, value: Bytes) -> Result<Hash, UsubaError> {
        let hash = blake3::hash(&value);

        let tx = self.db.begin_write()?;

        {
            let mut table = tx.open_table(MODULE_TABLE)?;
            table.insert(hash.to_string().as_str(), value.to_vec())?;
        }

        tx.commit()?;

        Ok(hash)
    }
}
