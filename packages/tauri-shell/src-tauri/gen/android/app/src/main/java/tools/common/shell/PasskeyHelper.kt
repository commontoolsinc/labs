package tools.common.shell

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.CancellationSignal
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.*
import androidx.credentials.exceptions.*
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Helper class for native passkey (WebAuthn) operations using Android Credential Manager API.
 * Requires Android 14+ (API 34) for full passkey support.
 */
object PasskeyHelper {
    private const val TAG = "PasskeyHelper"

    /**
     * Check if passkeys are available on this device
     */
    @JvmStatic
    fun isPasskeyAvailable(context: Context): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
    }

    /**
     * Create a new passkey
     * @param activity The current activity
     * @param requestJson JSON string containing the creation options
     * @return JSON string with the credential response
     */
    @JvmStatic
    fun createPasskey(activity: Activity, requestJson: String): String {
        return runBlocking {
            createPasskeyAsync(activity, requestJson)
        }
    }

    /**
     * Get an existing passkey for authentication
     * @param activity The current activity
     * @param requestJson JSON string containing the get options
     * @return JSON string with the assertion response
     */
    @JvmStatic
    fun getPasskey(activity: Activity, requestJson: String): String {
        return runBlocking {
            getPasskeyAsync(activity, requestJson)
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private suspend fun createPasskeyAsync(activity: Activity, requestJson: String): String {
        val credentialManager = CredentialManager.create(activity)

        try {
            val request = CreatePublicKeyCredentialRequest(
                requestJson = requestJson,
                clientDataHash = null,
                preferImmediatelyAvailableCredentials = false,
                origin = null,
                isAutoSelectAllowed = false
            )

            val result = credentialManager.createCredential(
                context = activity,
                request = request
            )

            return when (result) {
                is CreatePublicKeyCredentialResponse -> {
                    Log.d(TAG, "Passkey created successfully")
                    result.registrationResponseJson
                }
                else -> {
                    throw IllegalStateException("Unexpected credential type: ${result.type}")
                }
            }
        } catch (e: CreateCredentialCancellationException) {
            Log.w(TAG, "Passkey creation cancelled by user")
            throw e
        } catch (e: CreateCredentialException) {
            Log.e(TAG, "Failed to create passkey: ${e.type}", e)
            throw e
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private suspend fun getPasskeyAsync(activity: Activity, requestJson: String): String {
        val credentialManager = CredentialManager.create(activity)

        try {
            val getCredentialRequest = GetCredentialRequest(
                credentialOptions = listOf(
                    GetPublicKeyCredentialOption(
                        requestJson = requestJson,
                        clientDataHash = null,
                        allowedProviders = emptySet()
                    )
                ),
                origin = null,
                preferIdentityDocUi = false,
                preferUiBrandingComponentName = null,
                preferImmediatelyAvailableCredentials = false
            )

            val result = credentialManager.getCredential(
                context = activity,
                request = getCredentialRequest
            )

            return when (val credential = result.credential) {
                is PublicKeyCredential -> {
                    Log.d(TAG, "Passkey authentication successful")
                    credential.authenticationResponseJson
                }
                else -> {
                    throw IllegalStateException("Unexpected credential type: ${credential.type}")
                }
            }
        } catch (e: GetCredentialCancellationException) {
            Log.w(TAG, "Passkey authentication cancelled by user")
            throw e
        } catch (e: GetCredentialException) {
            Log.e(TAG, "Failed to get passkey: ${e.type}", e)
            throw e
        }
    }

    /**
     * Encode bytes to base64url without padding
     */
    private fun encodeBase64Url(data: ByteArray): String {
        return Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    /**
     * Decode base64url string to bytes
     */
    private fun decodeBase64Url(data: String): ByteArray {
        return Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }
}
