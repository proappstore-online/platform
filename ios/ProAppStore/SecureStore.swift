import Foundation
import Security

/// Installation credential ({"token","userId"}) or pairing proof ({"pairId","verifier"}) as one Keychain item.
/// AfterFirstUnlockThisDeviceOnly: readable while locked so background upload works, never in backups or
/// iCloud Keychain. Values never enter URLs, logs or web content.
struct SecureStore: Sendable {
    let service: String
    static let account = "device"

    init(service: String = "online.proappstore.companion") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: Self.account]
    }

    func read() throws -> [String: String] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess, let data = result as? Data else { throw CompanionError("The device connection could not be unlocked (\(status)).") }
        return try JSONDecoder().decode([String: String].self, from: data)
    }

    func write(_ value: [String: String]) throws {
        let data = try JSONEncoder().encode(value)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        }
        guard status == errSecSuccess else { throw CompanionError("Could not save the device connection (\(status)).") }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CompanionError("Could not clear the connection (\(status)).") }
    }
}
