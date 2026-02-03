import AuthenticationServices
import Foundation
import os.log

/// Bridge for native passkey (WebAuthn) operations on iOS using ASAuthorizationController.
/// Requires iOS 16+ for passkey support.
@available(iOS 16.0, *)
public class PasskeyBridge: NSObject {
    private static let logger = Logger(subsystem: "tools.common.shell", category: "Passkey")

    // MARK: - Shared Instance
    public static let shared = PasskeyBridge()

    // MARK: - Properties
    private var authorizationController: ASAuthorizationController?
    private var presentationAnchor: ASPresentationAnchor?
    private var continuation: CheckedContinuation<String, Error>?

    // MARK: - Public API

    /// Check if passkeys are available on this device
    public static func isPasskeyAvailable() -> Bool {
        if #available(iOS 16.0, *) {
            return true
        }
        return false
    }

    /// Create a new passkey
    /// - Parameters:
    ///   - rpId: Relying party identifier (e.g., "common.tools")
    ///   - rpName: Relying party display name
    ///   - userId: User identifier (base64url encoded)
    ///   - userName: User name for the credential
    ///   - userDisplayName: User display name
    ///   - challenge: Challenge bytes (base64url encoded)
    ///   - anchor: The presentation anchor for the authorization UI
    /// - Returns: JSON string containing the credential creation response
    public func createPasskey(
        rpId: String,
        rpName: String,
        userId: String,
        userName: String,
        userDisplayName: String,
        challenge: String,
        anchor: ASPresentationAnchor
    ) async throws -> String {
        self.presentationAnchor = anchor

        guard let challengeData = Data(base64URLEncoded: challenge) else {
            throw PasskeyError.invalidChallenge
        }

        guard let userIdData = Data(base64URLEncoded: userId) else {
            throw PasskeyError.invalidUserId
        }

        let publicKeyCredentialProvider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: rpId
        )

        let registrationRequest = publicKeyCredentialProvider.createCredentialRegistrationRequest(
            challenge: challengeData,
            name: userName,
            userID: userIdData
        )

        // Configure authenticator selection
        registrationRequest.userVerificationPreference = .required

        return try await performAuthorization(requests: [registrationRequest])
    }

    /// Get an existing passkey for authentication
    /// - Parameters:
    ///   - rpId: Relying party identifier
    ///   - challenge: Challenge bytes (base64url encoded)
    ///   - allowCredentials: Optional list of allowed credential IDs
    ///   - anchor: The presentation anchor for the authorization UI
    /// - Returns: JSON string containing the assertion response
    public func getPasskey(
        rpId: String,
        challenge: String,
        allowCredentials: [String]?,
        anchor: ASPresentationAnchor
    ) async throws -> String {
        self.presentationAnchor = anchor

        guard let challengeData = Data(base64URLEncoded: challenge) else {
            throw PasskeyError.invalidChallenge
        }

        let publicKeyCredentialProvider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: rpId
        )

        let assertionRequest = publicKeyCredentialProvider.createCredentialAssertionRequest(
            challenge: challengeData
        )

        // Set allowed credentials if provided
        if let allowCredentials = allowCredentials {
            assertionRequest.allowedCredentials = allowCredentials.compactMap { credentialId in
                guard let data = Data(base64URLEncoded: credentialId) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(
                    credentialID: data
                )
            }
        }

        assertionRequest.userVerificationPreference = .required

        return try await performAuthorization(requests: [assertionRequest])
    }

    // MARK: - Private Methods

    private func performAuthorization(requests: [ASAuthorizationRequest]) async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation

            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()

            self.authorizationController = controller
        }
    }
}

// MARK: - ASAuthorizationControllerDelegate

@available(iOS 16.0, *)
extension PasskeyBridge: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        Self.logger.info("Authorization completed successfully")

        do {
            let jsonResponse: String

            switch authorization.credential {
            case let credential as ASAuthorizationPlatformPublicKeyCredentialRegistration:
                jsonResponse = try buildRegistrationResponse(credential)
            case let credential as ASAuthorizationPlatformPublicKeyCredentialAssertion:
                jsonResponse = try buildAssertionResponse(credential)
            default:
                throw PasskeyError.unsupportedCredentialType
            }

            continuation?.resume(returning: jsonResponse)
            continuation = nil
        } catch {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Self.logger.error("Authorization failed: \(error.localizedDescription)")

        if let authError = error as? ASAuthorizationError {
            switch authError.code {
            case .canceled:
                continuation?.resume(throwing: PasskeyError.canceled)
            case .failed:
                continuation?.resume(throwing: PasskeyError.failed(authError.localizedDescription))
            case .invalidResponse:
                continuation?.resume(throwing: PasskeyError.invalidResponse)
            case .notHandled:
                continuation?.resume(throwing: PasskeyError.notHandled)
            case .notInteractive:
                continuation?.resume(throwing: PasskeyError.notInteractive)
            case .unknown:
                continuation?.resume(throwing: PasskeyError.unknown)
            @unknown default:
                continuation?.resume(throwing: PasskeyError.unknown)
            }
        } else {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    private func buildRegistrationResponse(
        _ credential: ASAuthorizationPlatformPublicKeyCredentialRegistration
    ) throws -> String {
        var response: [String: Any] = [
            "id": credential.credentialID.base64URLEncodedString(),
            "rawId": credential.credentialID.base64URLEncodedString(),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "response": [
                "clientDataJSON": credential.rawClientDataJSON.base64URLEncodedString(),
                "attestationObject": credential.rawAttestationObject?.base64URLEncodedString() ?? "",
                "transports": ["internal"]
            ] as [String : Any],
            "clientExtensionResults": [String: Any]()
        ]

        // Add PRF extension results if available (iOS 17+)
        if #available(iOS 17.0, *) {
            if let largeBlob = credential.largeBlob {
                // PRF is often backed by largeBlob on iOS
                response["clientExtensionResults"] = [
                    "prf": [
                        "enabled": true
                    ]
                ]
            }
        }

        let jsonData = try JSONSerialization.data(withJSONObject: response)
        guard let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw PasskeyError.serializationFailed
        }
        return jsonString
    }

    private func buildAssertionResponse(
        _ credential: ASAuthorizationPlatformPublicKeyCredentialAssertion
    ) throws -> String {
        var response: [String: Any] = [
            "id": credential.credentialID.base64URLEncodedString(),
            "rawId": credential.credentialID.base64URLEncodedString(),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "response": [
                "clientDataJSON": credential.rawClientDataJSON.base64URLEncodedString(),
                "authenticatorData": credential.rawAuthenticatorData.base64URLEncodedString(),
                "signature": credential.signature.base64URLEncodedString(),
                "userHandle": credential.userID.base64URLEncodedString()
            ],
            "clientExtensionResults": [String: Any]()
        ]

        // Add PRF extension results if available (iOS 17+)
        if #available(iOS 17.0, *) {
            if let largeBlob = credential.largeBlob {
                // Handle PRF results
                response["clientExtensionResults"] = [
                    "prf": [
                        "results": [
                            "first": largeBlob.base64URLEncodedString()
                        ]
                    ]
                ]
            }
        }

        let jsonData = try JSONSerialization.data(withJSONObject: response)
        guard let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw PasskeyError.serializationFailed
        }
        return jsonString
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

@available(iOS 16.0, *)
extension PasskeyBridge: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return presentationAnchor ?? UIApplication.shared.windows.first { $0.isKeyWindow }!
    }
}

// MARK: - Error Types

public enum PasskeyError: LocalizedError {
    case invalidChallenge
    case invalidUserId
    case unsupportedCredentialType
    case canceled
    case failed(String)
    case invalidResponse
    case notHandled
    case notInteractive
    case unknown
    case serializationFailed

    public var errorDescription: String? {
        switch self {
        case .invalidChallenge:
            return "Invalid challenge data"
        case .invalidUserId:
            return "Invalid user ID"
        case .unsupportedCredentialType:
            return "Unsupported credential type"
        case .canceled:
            return "User canceled the operation"
        case .failed(let message):
            return "Authorization failed: \(message)"
        case .invalidResponse:
            return "Invalid response from authenticator"
        case .notHandled:
            return "Request not handled"
        case .notInteractive:
            return "Request requires user interaction"
        case .unknown:
            return "Unknown error occurred"
        case .serializationFailed:
            return "Failed to serialize response"
        }
    }
}

// MARK: - Base64URL Extensions

extension Data {
    init?(base64URLEncoded string: String) {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        // Add padding if needed
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }

        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        return self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - C Interface for Rust FFI

@_cdecl("swift_is_passkey_available")
public func swift_is_passkey_available() -> Bool {
    return PasskeyBridge.isPasskeyAvailable()
}

@_cdecl("swift_create_passkey")
public func swift_create_passkey(
    rp_id: UnsafePointer<CChar>,
    rp_name: UnsafePointer<CChar>,
    user_id: UnsafePointer<CChar>,
    user_name: UnsafePointer<CChar>,
    user_display_name: UnsafePointer<CChar>,
    challenge: UnsafePointer<UInt8>,
    challenge_len: Int,
    callback: @escaping @convention(c) (UnsafePointer<CChar>?) -> Void
) {
    let rpId = String(cString: rp_id)
    let rpName = String(cString: rp_name)
    let userId = String(cString: user_id)
    let userName = String(cString: user_name)
    let userDisplayName = String(cString: user_display_name)
    let challengeData = Data(bytes: challenge, count: challenge_len)
    let challengeBase64 = challengeData.base64URLEncodedString()

    Task { @MainActor in
        guard #available(iOS 16.0, *) else {
            callback(nil)
            return
        }

        do {
            guard let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) else {
                callback(nil)
                return
            }

            let result = try await PasskeyBridge.shared.createPasskey(
                rpId: rpId,
                rpName: rpName,
                userId: userId,
                userName: userName,
                userDisplayName: userDisplayName,
                challenge: challengeBase64,
                anchor: window
            )

            result.withCString { cString in
                callback(cString)
            }
        } catch {
            callback(nil)
        }
    }
}

@_cdecl("swift_get_passkey")
public func swift_get_passkey(
    rp_id: UnsafePointer<CChar>,
    challenge: UnsafePointer<UInt8>,
    challenge_len: Int,
    callback: @escaping @convention(c) (UnsafePointer<CChar>?) -> Void
) {
    let rpId = String(cString: rp_id)
    let challengeData = Data(bytes: challenge, count: challenge_len)
    let challengeBase64 = challengeData.base64URLEncodedString()

    Task { @MainActor in
        guard #available(iOS 16.0, *) else {
            callback(nil)
            return
        }

        do {
            guard let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) else {
                callback(nil)
                return
            }

            let result = try await PasskeyBridge.shared.getPasskey(
                rpId: rpId,
                challenge: challengeBase64,
                allowCredentials: nil,
                anchor: window
            )

            result.withCString { cString in
                callback(cString)
            }
        } catch {
            callback(nil)
        }
    }
}
