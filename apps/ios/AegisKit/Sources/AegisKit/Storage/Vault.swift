import Foundation
import Security

/// Small secrets: identity, pairing, operation journal.
public protocol SecretStore: AnyObject, Sendable {
    func get(_ key: String) throws -> String?
    func set(_ key: String, _ value: String) throws
    func remove(_ key: String) throws
}

/// Keychain items with the same service/accounts as the Capacitor app, so an
/// existing pairing and identity carry over: service = bundle id, account = key.
public final class KeychainStore: SecretStore, @unchecked Sendable {
    private let service: String
    private static let keys: Set<String> = ["identity", "pairing", "operations"]

    public init(service: String = Bundle.main.bundleIdentifier ?? "ai.aegis.companion") {
        self.service = service
    }

    private func query(_ key: String) throws -> [String: Any] {
        guard Self.keys.contains(key) else { throw AegisError.message("Invalid key") }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func get(_ key: String) throws -> String? {
        var request = try query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw AegisError.message("Keychain unavailable")
        }
        return value
    }

    public func set(_ key: String, _ value: String) throws {
        let request = try query(key)
        let data = Data(value.utf8)
        guard data.count <= 2_000_000 else { throw AegisError.message("Invalid value") }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = request
            attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw AegisError.message("Couldn’t save credentials")
            }
        } else if status != errSecSuccess {
            throw AegisError.message("Couldn’t update credentials")
        }
    }

    public func remove(_ key: String) throws {
        let status = SecItemDelete(try query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AegisError.message("Couldn’t remove credentials")
        }
    }
}

/// In-memory store for tests and previews.
public final class MemoryStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    public init(_ values: [String: String] = [:]) { self.values = values }
    public func get(_ key: String) throws -> String? { lock.withLock { values[key] } }
    public func set(_ key: String, _ value: String) throws { lock.withLock { values[key] = value } }
    public func remove(_ key: String) throws { _ = lock.withLock { values.removeValue(forKey: key) } }
}

/// Larger, non-secret local data (snapshot cache, drafts) as files written atomically.
public final class FileStore: @unchecked Sendable {
    public let directory: URL

    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Aegis", isDirectory: true)
        self.directory = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    private func url(_ name: String) -> URL {
        let safe = name.map { $0.isLetter || $0.isNumber || "-_.".contains($0) ? $0 : "_" }
        return directory.appendingPathComponent(String(safe))
    }

    public func read(_ name: String) -> Data? { try? Data(contentsOf: url(name)) }

    public func write(_ name: String, _ data: Data) {
        try? data.write(to: url(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func remove(_ name: String) { try? FileManager.default.removeItem(at: url(name)) }

    public func removeAll(prefix: String) {
        let safePrefix = url(prefix).lastPathComponent
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix(safePrefix) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}
