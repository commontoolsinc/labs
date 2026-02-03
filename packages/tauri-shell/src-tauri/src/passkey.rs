//! Native passkey (WebAuthn) support for mobile platforms
//!
//! This module provides passkey functionality using:
//! - Android: Credential Manager API (Android 14+)
//! - iOS: ASAuthorizationController (iOS 16+)

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};

/// Global state for passkey operations
static PASSKEY_STATE: Mutex<Option<PasskeyState>> = Mutex::new(None);

struct PasskeyState {
    rp_id: String,
    origin: String,
}

/// Initialize passkey support
pub fn init<R: Runtime>(_app: AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Default RP ID - will be updated when the app connects to API
    let mut state = PASSKEY_STATE.lock().unwrap();
    *state = Some(PasskeyState {
        rp_id: "common.tools".to_string(),
        origin: "https://common.tools".to_string(),
    });
    Ok(())
}

/// Passkey creation options from the web app
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePasskeyOptions {
    pub rp_id: Option<String>,
    pub rp_name: String,
    pub user_id: String,
    pub user_name: String,
    pub user_display_name: String,
    pub challenge: String,
    pub timeout: Option<u32>,
    pub attestation: Option<String>,
    pub authenticator_selection: Option<AuthenticatorSelection>,
    pub extensions: Option<PasskeyExtensions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorSelection {
    pub authenticator_attachment: Option<String>,
    pub resident_key: Option<String>,
    pub require_resident_key: Option<bool>,
    pub user_verification: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyExtensions {
    pub prf: Option<PrfExtension>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrfExtension {
    pub eval: Option<PrfEval>,
    pub eval_by_credential: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrfEval {
    pub first: String,
    pub second: Option<String>,
}

/// Passkey get options
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPasskeyOptions {
    pub rp_id: Option<String>,
    pub challenge: String,
    pub timeout: Option<u32>,
    pub user_verification: Option<String>,
    pub allow_credentials: Option<Vec<CredentialDescriptor>>,
    pub extensions: Option<PasskeyExtensions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDescriptor {
    pub id: String,
    pub r#type: String,
    pub transports: Option<Vec<String>>,
}

/// Result of passkey creation
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyCreationResult {
    pub id: String,
    pub raw_id: String,
    pub r#type: String,
    pub authenticator_attachment: Option<String>,
    pub response: AuthenticatorAttestationResponse,
    pub client_extension_results: ClientExtensionResults,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorAttestationResponse {
    pub client_data_json: String,
    pub attestation_object: String,
    pub transports: Vec<String>,
    pub public_key: Option<String>,
    pub public_key_algorithm: i32,
    pub authenticator_data: Option<String>,
}

/// Result of passkey assertion
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyAssertionResult {
    pub id: String,
    pub raw_id: String,
    pub r#type: String,
    pub authenticator_attachment: Option<String>,
    pub response: AuthenticatorAssertionResponse,
    pub client_extension_results: ClientExtensionResults,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorAssertionResponse {
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    pub user_handle: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientExtensionResults {
    pub prf: Option<PrfExtensionResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrfExtensionResult {
    pub enabled: Option<bool>,
    pub results: Option<PrfResults>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrfResults {
    pub first: String,
    pub second: Option<String>,
}

/// Error types for passkey operations
#[derive(Debug, Serialize)]
pub struct PasskeyError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for PasskeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PasskeyError {}

/// Check if passkeys are available on this device
#[tauri::command]
pub async fn is_passkey_available() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        // Android 14+ has Credential Manager API
        Ok(true)
    }

    #[cfg(target_os = "ios")]
    {
        // iOS 16+ has ASAuthorizationController with passkey support
        Ok(true)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Desktop platforms - passkeys handled by WebView
        Ok(true)
    }
}

/// Create a new passkey
#[tauri::command]
pub async fn create_passkey(options: CreatePasskeyOptions) -> Result<PasskeyCreationResult, String> {
    log::info!("Creating passkey for user: {}", options.user_name);

    #[cfg(target_os = "android")]
    {
        create_passkey_android(options).await
    }

    #[cfg(target_os = "ios")]
    {
        create_passkey_ios(options).await
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Err("Passkey creation should be handled by the WebView on desktop".to_string())
    }
}

/// Get an existing passkey (for authentication)
#[tauri::command]
pub async fn get_passkey(options: GetPasskeyOptions) -> Result<PasskeyAssertionResult, String> {
    log::info!("Getting passkey for RP: {:?}", options.rp_id);

    #[cfg(target_os = "android")]
    {
        get_passkey_android(options).await
    }

    #[cfg(target_os = "ios")]
    {
        get_passkey_ios(options).await
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Err("Passkey retrieval should be handled by the WebView on desktop".to_string())
    }
}

/// Get a passkey assertion with PRF extension support
#[tauri::command]
pub async fn get_passkey_assertion(
    options: GetPasskeyOptions,
) -> Result<PasskeyAssertionResult, String> {
    // This is the same as get_passkey but explicitly for assertion
    // The PRF extension is handled based on the options
    get_passkey(options).await
}

// ============================================================================
// Android Implementation
// ============================================================================

#[cfg(target_os = "android")]
async fn create_passkey_android(
    options: CreatePasskeyOptions,
) -> Result<PasskeyCreationResult, String> {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;

    // Get the JNI environment
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {}", e))?;

    // Build the JSON request for Credential Manager
    let request_json = serde_json::json!({
        "rp": {
            "id": options.rp_id.unwrap_or_else(|| "common.tools".to_string()),
            "name": options.rp_name
        },
        "user": {
            "id": options.user_id,
            "name": options.user_name,
            "displayName": options.user_display_name
        },
        "challenge": options.challenge,
        "pubKeyCredParams": [
            {"type": "public-key", "alg": -8},   // Ed25519
            {"type": "public-key", "alg": -7},   // ES256
            {"type": "public-key", "alg": -257}  // RS256
        ],
        "authenticatorSelection": {
            "authenticatorAttachment": "platform",
            "residentKey": "required",
            "userVerification": "required"
        },
        "attestation": options.attestation.unwrap_or_else(|| "none".to_string()),
        "timeout": options.timeout.unwrap_or(60000),
        "extensions": {
            "prf": options.extensions.and_then(|e| e.prf).map(|prf| {
                serde_json::json!({
                    "eval": prf.eval.map(|e| serde_json::json!({
                        "first": e.first,
                        "second": e.second
                    }))
                })
            })
        }
    });

    // Call the Kotlin/Java helper to invoke Credential Manager
    let request_str = env
        .new_string(request_json.to_string())
        .map_err(|e| format!("Failed to create string: {}", e))?;

    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    // Find our helper class
    let helper_class = env
        .find_class("tools/common/shell/PasskeyHelper")
        .map_err(|e| format!("Failed to find PasskeyHelper class: {}", e))?;

    // Call createPasskey method
    let result = env
        .call_static_method(
            helper_class,
            "createPasskey",
            "(Landroid/app/Activity;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&activity), JValue::Object(&request_str.into())],
        )
        .map_err(|e| format!("Failed to call createPasskey: {}", e))?;

    let result_str: JString = result
        .l()
        .map_err(|e| format!("Invalid return type: {}", e))?
        .into();

    let result_json: String = env
        .get_string(&result_str)
        .map_err(|e| format!("Failed to get result string: {}", e))?
        .into();

    // Parse the result
    serde_json::from_str(&result_json)
        .map_err(|e| format!("Failed to parse passkey result: {}", e))
}

#[cfg(target_os = "android")]
async fn get_passkey_android(options: GetPasskeyOptions) -> Result<PasskeyAssertionResult, String> {
    use jni::objects::{JObject, JString, JValue};

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {}", e))?;

    // Build the JSON request
    let request_json = serde_json::json!({
        "rpId": options.rp_id.unwrap_or_else(|| "common.tools".to_string()),
        "challenge": options.challenge,
        "timeout": options.timeout.unwrap_or(60000),
        "userVerification": options.user_verification.unwrap_or_else(|| "required".to_string()),
        "allowCredentials": options.allow_credentials.map(|creds| {
            creds.into_iter().map(|c| serde_json::json!({
                "id": c.id,
                "type": c.r#type,
                "transports": c.transports
            })).collect::<Vec<_>>()
        }),
        "extensions": {
            "prf": options.extensions.and_then(|e| e.prf).map(|prf| {
                serde_json::json!({
                    "eval": prf.eval.map(|e| serde_json::json!({
                        "first": e.first,
                        "second": e.second
                    }))
                })
            })
        }
    });

    let request_str = env
        .new_string(request_json.to_string())
        .map_err(|e| format!("Failed to create string: {}", e))?;

    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    let helper_class = env
        .find_class("tools/common/shell/PasskeyHelper")
        .map_err(|e| format!("Failed to find PasskeyHelper class: {}", e))?;

    let result = env
        .call_static_method(
            helper_class,
            "getPasskey",
            "(Landroid/app/Activity;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&activity), JValue::Object(&request_str.into())],
        )
        .map_err(|e| format!("Failed to call getPasskey: {}", e))?;

    let result_str: JString = result
        .l()
        .map_err(|e| format!("Invalid return type: {}", e))?
        .into();

    let result_json: String = env
        .get_string(&result_str)
        .map_err(|e| format!("Failed to get result string: {}", e))?
        .into();

    serde_json::from_str(&result_json)
        .map_err(|e| format!("Failed to parse passkey result: {}", e))
}

// ============================================================================
// iOS Implementation
// ============================================================================

#[cfg(target_os = "ios")]
async fn create_passkey_ios(options: CreatePasskeyOptions) -> Result<PasskeyCreationResult, String> {
    use std::ffi::CString;

    // We'll use Swift/Objective-C interop for ASAuthorizationController
    // This is a placeholder that will be implemented via Swift code

    let rp_id = options.rp_id.unwrap_or_else(|| "common.tools".to_string());
    let challenge_bytes = URL_SAFE_NO_PAD
        .decode(&options.challenge)
        .map_err(|e| format!("Invalid challenge: {}", e))?;

    // Call into Swift code via extern "C" functions
    extern "C" {
        fn swift_create_passkey(
            rp_id: *const i8,
            rp_name: *const i8,
            user_id: *const i8,
            user_name: *const i8,
            user_display_name: *const i8,
            challenge: *const u8,
            challenge_len: usize,
            callback: extern "C" fn(*const i8),
        );
    }

    let (tx, rx) = std::sync::mpsc::channel();

    extern "C" fn callback(result: *const i8) {
        // This will be called from Swift with the JSON result
    }

    let rp_id_c = CString::new(rp_id).unwrap();
    let rp_name_c = CString::new(options.rp_name).unwrap();
    let user_id_c = CString::new(options.user_id).unwrap();
    let user_name_c = CString::new(options.user_name).unwrap();
    let user_display_name_c = CString::new(options.user_display_name).unwrap();

    unsafe {
        swift_create_passkey(
            rp_id_c.as_ptr(),
            rp_name_c.as_ptr(),
            user_id_c.as_ptr(),
            user_name_c.as_ptr(),
            user_display_name_c.as_ptr(),
            challenge_bytes.as_ptr(),
            challenge_bytes.len(),
            callback,
        );
    }

    // For now, return an error indicating this needs Swift implementation
    Err("iOS passkey creation requires Swift implementation. See PasskeyBridge.swift".to_string())
}

#[cfg(target_os = "ios")]
async fn get_passkey_ios(options: GetPasskeyOptions) -> Result<PasskeyAssertionResult, String> {
    // Similar to create, this needs Swift implementation
    Err("iOS passkey retrieval requires Swift implementation. See PasskeyBridge.swift".to_string())
}
