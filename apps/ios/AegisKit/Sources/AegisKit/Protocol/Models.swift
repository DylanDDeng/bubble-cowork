import Foundation

// Mirrors src/shared/remote/protocol.ts (aegis.remote.v1). Keep in sync.

public let remoteProtocol = "aegis.remote.v1"
/// Upload chunks stay well under the relay's 256 KB message cap.
public let attachmentChunkBytes = 96 * 1024

public enum RemoteEnvironment: String, Codable, Sendable {
    case development, production, fixture

    public var label: String {
        switch self {
        case .development: return "Aegis Dev"
        case .production: return "Aegis"
        case .fixture: return "Fixture"
        }
    }

    /// The environment this build talks to; a pairing code can't change it.
    public static var native: RemoteEnvironment {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }
}

public struct RemoteTaskSettings: Codable, Equatable, Hashable, Sendable {
    public var model: String?
    public var compatibleProviderId: String?
    public var effort: String?
    public var fast: Bool?
    public var permissionMode: String?
    public var plan: Bool?

    public init(model: String? = nil, compatibleProviderId: String? = nil, effort: String? = nil,
                fast: Bool? = nil, permissionMode: String? = nil, plan: Bool? = nil) {
        self.model = model
        self.compatibleProviderId = compatibleProviderId
        self.effort = effort
        self.fast = fast
        self.permissionMode = permissionMode
        self.plan = plan
    }
}

public struct RemoteProject: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// Git repository: the hero says "build" instead of "work on".
    public let isRepo: Bool?
}

public struct RemoteSession: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let provider: String
    public let status: String
    public let updatedAt: Double
    public let runId: String?
    public let handoffSourceProvider: String?
    public let settings: RemoteTaskSettings?

    public var isRunning: Bool { runId != nil || status == "running" || status == "stopping" }
    public var isFailed: Bool { status == "error" || status == "failed" }
}

public struct RemoteMessage: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let streaming: Bool?
    public let at: Double?
    /// Size-bounded copy of the desktop stream message.
    public let raw: JSONValue?
}

public struct RemotePermission: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let requestId: String
    public let sessionId: String
    public let runId: String
    public let toolName: String
    public let detail: String
    public let canApprove: Bool
    public var id: String { requestId }
}

public struct RemoteSnapshot: Codable, Equatable, Sendable {
    public let `protocol`: String
    public let hostBootId: String
    public let machineName: String
    public let environment: RemoteEnvironment
    public let serverTime: Double
    public let projects: [RemoteProject]
    public let sessions: [RemoteSession]
    public let permissions: [RemotePermission]
    public var sessionId: String?
    public var messages: [RemoteMessage]?
    public var before: Double?
    public let revision: String
    public var historyRevision: String?
}

public struct CommandResult: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case accepted, completed, rejected, unknown }
    public let commandId: String
    public var state: State
    public var sessionId: String?
    public var error: String?

    public var unresolved: Bool { state == .unknown || state == .accepted }
}

public struct RemoteAttachment: Codable, Equatable, Sendable {
    public let attachmentId: String
    public let name: String
    public let size: Double
    public let kind: String
    public let mimeType: String
}

/// A journaled mutation (create/send/stop/permission) and what the Mac said about it.
public struct RemoteOperation: Codable, Equatable, Sendable {
    public var request: JSONValue
    public var result: CommandResult

    public var method: String? { request["method"]?.stringValue }
    public var sessionId: String? { request["sessionId"]?.stringValue }
    public var prompt: String? { request["prompt"]?.stringValue }
}

public struct Pairing: Codable, Equatable, Sendable {
    public let version: Int
    public let environment: RemoteEnvironment
    public let relay: String
    public let room: String
    public let routeToken: String
    public let hostPeerId: String
    public var invite: String?
    public var expiresAt: Double?
    public let name: String

    /// Accepts the `aegis(-dev)://pair#<json>` link or raw JSON.
    public static func parse(_ value: String, now: Date = Date()) throws -> Pairing {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let json: String
        if raw.hasPrefix("{") {
            json = raw
        } else {
            guard let hash = raw.firstIndex(of: "#"),
                  let decoded = String(raw[raw.index(after: hash)...]).removingPercentEncoding else {
                throw AegisError.message("That isn’t an Aegis pairing link.")
            }
            json = decoded
        }
        let pairing: Pairing
        do { pairing = try JSONDecoder().decode(Pairing.self, from: Data(json.utf8)) } catch {
            throw AegisError.message("That isn’t an Aegis pairing link.")
        }
        try pairing.validate(now: now)
        return pairing
    }

    func validate(now: Date) throws {
        let invalid = AegisError.message("That isn’t an Aegis pairing link.")
        guard version == 1,
              room.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              (32...128).contains(routeToken.count),
              (20...160).contains(hostPeerId.count),
              name.count <= 100,
              let url = URL(string: relay), let scheme = url.scheme else { throw invalid }
        if let invite, !(32...128).contains(invite.count) { throw invalid }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
        guard scheme == "wss" || (scheme == "ws" && loopback) else {
            throw AegisError.message("The relay must use WSS.")
        }
        if invite != nil, (expiresAt ?? 0) < now.timeIntervalSince1970 * 1000 {
            throw AegisError.message("This pairing code expired. Generate a new one on your Mac.")
        }
    }
}
