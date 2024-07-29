use serde::{Serialize, Deserialize};
use gloo_storage::{LocalStorage, Storage as GlooStorage};
use std::collections::HashMap;

#[derive(Serialize, Deserialize)]
struct Document<T> {
    id: String,
    data: T,
}

pub fn save<T: Serialize>(collection: &str, id: &str, data: &T) -> Result<(), String> {
    let doc = Document {
        id: id.to_string(),
        data: data.clone(),
    };

    let serialized = serde_json::to_string(&doc)
        .map_err(|e| format!("Serialization error: {}", e))?;
    let key = format!("{}:{}", collection, id);
    LocalStorage::set(&key, serialized)
        .map_err(|e| format!("Storage error: {}", e))?;
    
    Ok(())
}

pub fn get<T: for<'de> Deserialize<'de>>(collection: &str, id: &str) -> Result<Option<T>, String> {
    let key = format!("{}:{}", collection, id);
    if let Ok(value) = LocalStorage::get::<String>(&key) {
        let doc: Document<T> = serde_json::from_str(&value)
            .map_err(|e| format!("Deserialization error: {}", e))?;
        Ok(Some(doc.data))
    } else {
        Ok(None)
    }
}

pub fn delete(collection: &str, id: &str) {
    let key = format!("{}:{}", collection, id);
    LocalStorage::delete(&key);
}

pub fn list<T: for<'de> Deserialize<'de>>(collection: &str) -> Result<HashMap<String, T>, String> {
    let prefix = format!("{}:", collection);
    let all_items: HashMap<String, String> = LocalStorage::get_all()
        .map_err(|e| format!("Error getting all items: {}", e))?;
    
    let mut result = HashMap::new();

    for (key, value) in all_items {
        if key.starts_with(&prefix) {
            let doc: Document<T> = serde_json::from_str(&value)
                .map_err(|e| format!("Deserialization error for key {}: {}", key, e))?;
            result.insert(doc.id, doc.data);
        }
    }

    Ok(result)
}