import Security
import XCTest
@testable import ProAppStore

final class SecureStoreTests: XCTestCase {
    /// A separate service so the test never touches the app's own credential.
    private let store = SecureStore(service: "online.proappstore.companion.tests")

    override func tearDownWithError() throws { try store.clear() }

    func testCredentialRoundTripAndClear() throws {
        try store.clear()
        XCTAssertEqual(try store.read(), [:])
        try store.write(["pairId": "abc", "verifier": "def"])
        try store.write(["token": "test-device-secret", "userId": "u1"]) // overwrite replaces, never merges
        XCTAssertEqual(try SecureStore(service: store.service).read(), ["token": "test-device-secret", "userId": "u1"])
        try store.clear()
        XCTAssertNil(try store.read()["token"])
    }

    func testItemIsReadableAfterFirstUnlockAndStaysOnThisDevice() throws {
        try store.write(["token": "t"])
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: store.service,
                                    kSecAttrAccount as String: SecureStore.account, kSecReturnAttributes as String: true]
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let attributes = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }
}
