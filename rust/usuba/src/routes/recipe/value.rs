use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{UsubaError, Value};

#[derive(ToSchema, Serialize, Deserialize, Clone, Debug)]
pub struct JsonValue {
    tag: String,
    val: serde_json::Value,
}

impl TryFrom<JsonValue> for Value {
    type Error = UsubaError;

    fn try_from(value: JsonValue) -> Result<Self, Self::Error> {
        Ok(match value.tag.as_str() {
            "string" => Value::String(
                value
                    .val
                    .as_str()
                    .ok_or_else(|| {
                        UsubaError::InvalidModule(String::from(
                            "Value could not be interpreted as a string",
                        ))
                    })?
                    .into(),
            ),
            _ => {
                return Err(UsubaError::Internal(format!(
                    "Value type not yet supported: {}",
                    value.tag
                )))
            }
        })
    }
}

impl TryFrom<Value> for JsonValue {
    type Error = UsubaError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        match value {
            Value::String(val) => Ok(JsonValue {
                tag: "string".into(),
                val: val.into(),
            }),
            _ => Err(UsubaError::Internal(format!(
                "Value type not yet supported"
            ))),
        }
    }
}
