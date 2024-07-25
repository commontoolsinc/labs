use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct ClassificationData {
    pub title: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub emoji: String,
    pub sensitivity: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct DataGem {
    pub classification: Option<ClassificationData>,
    pub description: String,
    pub json_data: String,
}
