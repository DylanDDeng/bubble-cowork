import Foundation
import Observation

/// The phone side of aegis.remote.v1: pairing, the encrypted connection to the
/// Mac, snapshots, history pages, journaled mutations and uploads.
@MainActor
@Observable
public final class RemoteClient {
    public enum Connection: String, Sendable { case unpaired, connecting, confirming, connected, offline }
    public enum Freshness: String, Sendable { case cached, catchingUp, current }

    public private(set) var connection: Connection = .unpaired
    public private(set) var freshness: Freshness = .cached
    public private(set) var snapshot: RemoteSnapshot?
    /// Agent catalog from the Mac (models, efforts, fast mode); forwarded to the shared JS logic.
    public private(set) var agentOptions: JSONValue?
    public private(set) var messagesBySession: [String: RemoteSnapshot] = [:]
    public private(set) var pairing: Pairing?
    public var error = ""
    public private(set) var peerId = ""
    public private(set) var selectedSession: String?
    public private(set) var operations: [String: RemoteOperation] = [:]

    public let environment: RemoteEnvironment
    private let secrets: SecretStore
    public let files: FileStore
    private let deviceName: String
    private let openWire: @Sendable (URL) async throws -> WireConnection

    @ObservationIgnored private var channel: SecureChannel?
    @ObservationIgnored private var wire: WireConnection?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var refreshTimer: Task<Void, Never>?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var serverOffset: Double = 0
    /// When the Mac last said anything; polls answer every few seconds, so silence means a stalled path.
    @ObservationIgnored private var lastHeard: Double = 0
    /// Commands on the wire right now; a resend waits until the earlier attempt settles.
    /// Commands awaiting the Mac's answer right now.
    private var inFlight = Set<String>()

    /// Unconfirmed commands no request is waiting on: the Mac didn't answer in time,
    /// or the connection dropped. reconcile() delivers them; the app shows these.
    public var stalledCount: Int {
        operations.filter { $0.value.result.unresolved && !inFlight.contains($0.key) }.count
    }

    /// A request for this command is waiting on the Mac's answer right now.
    public func isInFlight(_ commandId: String) -> Bool { inFlight.contains(commandId) }
    @ObservationIgnored private var reconciling = false
    /// The first snapshot on each connection is fetched in full (the Mac may have restarted).
    @ObservationIgnored private var fullRefresh = true
    /// Set while the app is in the background: no polls, no reconnects (the Keychain is
    /// locked with the phone), and the Mac keeps sending push notifications.
    @ObservationIgnored private var backgroundSince: Double?

    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timer: Task<Void, Never>
    }

    public init(
        environment: RemoteEnvironment = .native,
        secrets: SecretStore = KeychainStore(),
        files: FileStore = FileStore(),
        deviceName: String = "iPhone",
        openWire: @escaping @Sendable (URL) async throws -> WireConnection = { url in
            let socket = RelaySocket(url: url)
            try await socket.waitOpen()
            return socket
        }
    ) {
        self.environment = environment
        self.secrets = secrets
        self.files = files
        self.deviceName = deviceName
        self.openWire = openWire
    }

    private static var now: Double { Date().timeIntervalSince1970 * 1000 }
    private static let journalFile = "operations.json"
    private func cacheName(_ host: String) -> String { "cache-" + host + ".json" }
    public func draftName(_ key: String) -> String { "draft-" + (pairing?.hostPeerId ?? "") + "-" + key }

    // MARK: Lifecycle

    public func start() async {
        do {
            guard let stored = try secrets.get("pairing") else { return }
            let pairing = try JSONDecoder().decode(Pairing.self, from: Data(stored.utf8))
            try checkEnvironment(pairing)
            self.pairing = pairing
            if let data = files.read(cacheName(pairing.hostPeerId)),
               let cache = try? JSONDecoder().decode(Cache.self, from: data) {
                snapshot = cache.snapshot
                messagesBySession = cache.messages
            }
            if let data = files.read(Self.journalFile) {
                operations = (try? JSONDecoder().decode([String: RemoteOperation].self, from: data)) ?? [:]
            } else if let journal = try? secrets.get("operations") {
                // Older builds kept it in the Keychain, which can't be written while the phone is locked.
                operations = (try? JSONDecoder().decode([String: RemoteOperation].self, from: Data(journal.utf8))) ?? [:]
                saveOperations()
                try? secrets.remove("operations")
            }
            await connect()
        } catch {
            self.error = "Couldn’t restore the connection. Pair again."
        }
    }

    private struct Cache: Codable {
        var snapshot: RemoteSnapshot
        var messages: [String: RemoteSnapshot]
    }

    private func checkEnvironment(_ pairing: Pairing) throws {
        guard pairing.environment == environment else {
            throw AegisError.message("This app only connects to \(environment.label). Use a pairing code from that desktop app.")
        }
    }

    public func pair(_ value: String) async throws {
        let offer = try Pairing.parse(value)
        try checkEnvironment(offer)
        await disconnect(forget: true)
        pairing = offer
        try secrets.set("pairing", String(decoding: try JSONEncoder.aegis.encode(offer), as: UTF8.self))
        await connect()
    }

    public func disconnect(forget: Bool = false) async {
        generation += 1
        retry?.cancel()
        refreshTimer?.cancel()
        poll?.cancel()
        let channel = self.channel
        self.channel = nil
        wire?.close()
        wire = nil
        await channel?.close()
        failPending(AegisError.connection("Disconnected"))
        refreshing = false
        connection = forget ? .unpaired : .offline
        freshness = .cached
        if forget {
            if let host = pairing?.hostPeerId {
                files.remove(cacheName(host))
                files.removeAll(prefix: "draft-" + host + "-")
            }
            try? secrets.remove("pairing")
            try? secrets.remove("operations")
            files.remove(Self.journalFile)
            pairing = nil
            snapshot = nil
            messagesBySession = [:]
            operations = [:]
            selectedSession = nil
        }
    }

    private func failPending(_ error: Error) {
        let all = pending
        pending = [:]
        for item in all.values {
            item.timer.cancel()
            item.continuation.resume(throwing: error)
        }
    }

    private func loadIdentity() throws -> Identity {
        if let raw = try secrets.get("identity"),
           let identity = try? JSONDecoder().decode(Identity.self, from: Data(raw.utf8)) {
            return identity
        }
        let identity = Identity.create()
        try secrets.set("identity", String(decoding: try JSONEncoder.aegis.encode(identity), as: UTF8.self))
        return identity
    }

    /// Starts (or restarts) the connection; returns once it is under way.
    public func connect() async {
        guard pairing != nil else { return }
        await disconnect()
        let generation = self.generation
        connection = .connecting
        error = ""
        Task { await self.run(generation) }
    }

    /// One connection attempt: relay, Noise, auth, then the message loop until it closes.
    private func run(_ generation: Int) async {
        guard generation == self.generation, let offer = pairing else { return }
        let identity: Identity
        do { identity = try loadIdentity() } catch {
            self.error = error.localizedDescription
            closed(generation)
            return
        }
        peerId = identity.peerId
        do {
            guard let url = URL(string: offer.relay) else { throw AegisError.message("Invalid relay") }
            let wire = try await openWire(url)
            guard generation == self.generation else { wire.close(); return }
            self.wire = wire
            let hello: JSONValue = .object(["role": "phone", "room": .string(offer.room), "token": .string(offer.routeToken)])
            try await wire.send(.text(String(decoding: try JSONEncoder.aegis.encode(hello), as: UTF8.self)))
            // The relay answers {"type":"peer"} once the Mac is in the room.
            guard case .text(let control) = try await wire.receive(),
                  let data = control.data(using: .utf8),
                  (try? JSONDecoder().decode(JSONValue.self, from: data))?["type"]?.stringValue == "peer" else {
                throw AegisError.connection("Relay rejected the connection")
            }
            let channel = try await SecureChannel.open(wire: wire, identity: identity, initiator: true, expectedPeer: offer.hostPeerId)
            guard generation == self.generation else { await channel.close(); return }
            self.channel = channel
            connection = .confirming
            var auth: [String: JSONValue] = [
                "type": "auth", "protocol": .string(remoteProtocol),
                "environment": .string(environment.rawValue), "name": .string(deviceName),
            ]
            if let invite = offer.invite { auth["invite"] = .string(invite) }
            try await channel.sendJSON(.object(auth))
            for try await body in channel.messages {
                guard generation == self.generation else { break }
                lastHeard = Self.now
                guard let message = try? JSONDecoder().decode(JSONValue.self, from: body) else { continue }
                if try await handle(message, generation: generation) { break }
            }
        } catch {
            // Lost or refused connections show as "offline"; only real failures
            // (handshake, incompatible Mac, Keychain) become an error notice.
            if generation == self.generation, !Self.isTransient(error) {
                self.error = error.localizedDescription
            }
        }
        closed(generation)
    }

    private static func isTransient(_ error: Error) -> Bool {
        if error is CancellationError || error is URLError { return true }
        if case AegisError.connection = error { return true }
        return (error as NSError).domain == NSURLErrorDomain || (error as NSError).domain == NSPOSIXErrorDomain
    }

    /// Returns true when the connection should stop (revoked / rejected).
    private func handle(_ message: JSONValue, generation: Int) async throws -> Bool {
        switch message["type"]?.stringValue {
        case "authenticated":
            guard message["protocol"]?.stringValue == remoteProtocol else {
                throw AegisError.message("This Mac runs an incompatible version of Aegis.")
            }
            guard message["environment"]?.stringValue == environment.rawValue else {
                throw AegisError.message("Desktop environment doesn’t match.")
            }
            serverOffset = (message["serverTime"]?.numberValue ?? Self.now) - Self.now
            connection = .connected
            freshness = .catchingUp
            error = ""
            if var offer = pairing {
                offer.invite = nil
                offer.expiresAt = nil
                pairing = offer
                try? secrets.set("pairing", String(decoding: try JSONEncoder.aegis.encode(offer), as: UTF8.self))
            }
            lastHeard = Self.now
            fullRefresh = true
            Task { await refresh() }
            Task { await reconcile() }
            Task { await loadOptions() }
            Task { await sendPushRegistration() }
            poll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled, let self else { return }
                    guard self.backgroundSince == nil else { continue }
                    // The socket can stay open while the path drops everything (lossy
                    // cross-border links). Reconnect rather than wait for TCP to give up.
                    if Self.now - self.lastHeard > Self.stallTimeout * 1000 {
                        Task { await self.connect() }
                        return
                    }
                    Task { await self.refresh() }
                    if self.operations.values.contains(where: \.result.unresolved) {
                        Task { await self.reconcile() }
                    }
                    Task { await self.reconcile() }
                }
            }
        case "revoked":
            await disconnect(forget: true)
            error = "Your Mac removed this iPhone’s access."
            return true
        case "auth-rejected":
            await disconnect(forget: true)
            error = "This pairing is no longer valid. Pair again."
            return true
        case "changed":
            refreshTimer?.cancel()
            refreshTimer = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        case "response":
            guard let id = message["id"]?.stringValue, let item = pending.removeValue(forKey: id) else { break }
            item.timer.cancel()
            if let code = message["error"]?.stringValue {
                item.continuation.resume(throwing: AegisError.rejected(code))
            } else {
                item.continuation.resume(returning: message["result"] ?? .null)
            }
        default:
            break
        }
        return false
    }

    private func closed(_ generation: Int) {
        guard generation == self.generation else { return }
        connection = pairing == nil ? .unpaired : .offline
        freshness = .cached
        let channel = self.channel
        self.channel = nil
        Task { await channel?.close() }
        wire?.close()
        wire = nil
        poll?.cancel()
        failPending(AegisError.connection("Connection lost. Checking whether it was delivered."))
        guard pairing != nil else { return }
        guard backgroundSince == nil else { return } // foreground() reconnects
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, self?.backgroundSince == nil else { return }
            await self?.connect()
        }
    }

    // MARK: Requests

    static let stallTimeout: Double = 15

    public func request(_ payload: [String: JSONValue], timeout: TimeInterval = 20) async throws -> JSONValue {
        guard connection == .connected, let channel else { throw AegisError.connection("Your Mac isn’t connected") }
        let id = (payload["commandId"]?.stringValue) ?? UUID().uuidString.lowercased()
        var body = payload
        body["id"] = .string(id)
        let data = try JSONEncoder.aegis.encode(JSONValue.object(body))
        return try await withCheckedThrowingContinuation { continuation in
            let timer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled, let self, let item = self.pending.removeValue(forKey: id) else { return }
                item.continuation.resume(throwing: AegisError.connection("Your Mac hasn’t confirmed yet"))
            }
            pending[id] = Pending(continuation: continuation, timer: timer)
            Task {
                do { try await channel.send(data) } catch {
                    if let item = self.pending.removeValue(forKey: id) {
                        item.timer.cancel()
                        item.continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    public func refresh() async {
        guard connection == .connected else { return }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        let generation = self.generation
        let sessionId = selectedSession
        // Routine polls stay quiet; only the first sync on a connection shows as catching up.
        if fullRefresh { freshness = .catchingUp }
        do {
            var params: [String: JSONValue] = ["method": "snapshot"]
            if let sessionId { params["sessionId"] = .string(sessionId) }
            let known = !fullRefresh && snapshot?.sessionId == sessionId ? snapshot?.revision : nil
            if let known { params["knownRevision"] = .string(known) }
            let response = try await request(params)
            if response["unchanged"] == .bool(true), response["revision"]?.stringValue == known {
                if generation == self.generation, sessionId == selectedSession {
                    freshness = .current
                    error = ""
                }
            } else if generation == self.generation, sessionId == selectedSession {
                var state = try response.decode(RemoteSnapshot.self)
                snapshot = state
                let allowed = Set(state.sessions.map(\.id))
                messagesBySession = messagesBySession.filter { allowed.contains($0.key) }
                if let sessionId {
                    let previous = messagesBySession[sessionId]
                    if let previous, previous.historyRevision == state.historyRevision, previous.hostBootId == state.hostBootId {
                        state.messages = previous.messages
                        state.before = previous.before
                    }
                    if previous?.revision != state.revision {
                        if let previous, previous.messages == state.messages { state.messages = previous.messages }
                        messagesBySession[sessionId] = state
                    }
                }
                freshness = .current
                error = ""
                fullRefresh = false
                if let host = pairing?.hostPeerId, let data = try? JSONEncoder().encode(Cache(snapshot: state, messages: messagesBySession)) {
                    files.write(cacheName(host), data)
                }
            }
        } catch {
            if generation == self.generation {
                freshness = .cached
                self.error = error.localizedDescription
                if case AegisError.rejected("SCOPE_DENIED") = error, let sessionId {
                    messagesBySession[sessionId] = nil
                    selectedSession = nil
                    refreshAgain = true
                }
            }
        }
        if generation == self.generation {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                await refresh()
            }
        }
    }

    public func loadOptions() async {
        if let options = try? await request(["method": "options"]) { agentOptions = options }
    }

    /// Slash commands and skills for a session, or for a new task in a project.
    public func capabilities(provider: String, sessionId: String?, projectId: String?) async throws -> JSONValue {
        var params: [String: JSONValue] = ["method": "capabilities", "provider": .string(provider)]
        if let sessionId { params["sessionId"] = .string(sessionId) }
        if let projectId { params["projectId"] = .string(projectId) }
        return try await request(params)
    }

    // MARK: Notifications

    /// This app's APNs registration; the Mac gets it after every authentication.
    public var push: PushRegistration? {
        didSet {
            if push != oldValue, connection == .connected { Task { await sendPushRegistration() } }
        }
    }

    func sendPushRegistration() async {
        guard let push else { return }
        _ = try? await request([
            "method": "push.register",
            "deviceToken": .string(push.deviceToken),
            "topic": .string(push.topic),
            "environment": .string(push.environment),
        ])
    }

    // MARK: Project files (read-only)

    public func listFiles(projectId: String, path: String = "") async throws -> [RemoteFileEntry] {
        var params: [String: JSONValue] = ["method": "files.list", "projectId": .string(projectId)]
        if !path.isEmpty { params["path"] = .string(path) }
        return try await request(params).decode([RemoteFileEntry].self)
    }

    public func searchFiles(projectId: String, query: String) async throws -> [RemoteFileEntry] {
        try await request(["method": "files.search", "projectId": .string(projectId), "query": .string(query)]).decode([RemoteFileEntry].self)
    }

    /// `path` is relative to the project, or absolute inside it.
    public func readFile(projectId: String, path: String) async throws -> RemoteFileContent {
        try await request(["method": "files.read", "projectId": .string(projectId), "path": .string(path)], timeout: 30).decode(RemoteFileContent.self)
    }

    public func select(_ sessionId: String?) {
        guard selectedSession != sessionId else { return }
        selectedSession = sessionId
        Task { await refresh() }
    }

    /// Loads the page of history before the oldest loaded message.
    public func older() async throws {
        guard let sessionId = selectedSession, let previous = messagesBySession[sessionId], let before = previous.before else { return }
        let generation = self.generation
        var params: [String: JSONValue] = ["method": "snapshot", "sessionId": .string(sessionId), "before": .number(before)]
        if let revision = previous.historyRevision { params["historyRevision"] = .string(revision) }
        let state = try await request(params).decode(RemoteSnapshot.self)
        guard generation == self.generation, selectedSession == sessionId,
              messagesBySession[sessionId]?.historyRevision == previous.historyRevision else { return }
        var seen = Set<String>()
        var merged: [RemoteMessage] = []
        for message in (state.messages ?? []) + (previous.messages ?? []) where seen.insert(message.id).inserted {
            merged.append(message)
        }
        var next = previous
        next.messages = merged
        next.before = state.before
        messagesBySession[sessionId] = next
    }

    /// Sends a file in relay-sized chunks; returns its attachment.
    public func upload(name: String, bytes: Data, progress: (@MainActor (Double) -> Void)? = nil) async throws -> RemoteAttachment {
        let uploadId = UUID().uuidString.lowercased()
        let total = max(1, Int(ceil(Double(bytes.count) / Double(attachmentChunkBytes))))
        var result: JSONValue = .null
        for index in 0..<total {
            let start = bytes.startIndex + index * attachmentChunkBytes
            let part = bytes.subdata(in: start..<min(start + attachmentChunkBytes, bytes.endIndex))
            result = try await request([
                "method": "attachment.chunk", "uploadId": .string(uploadId), "name": .string(name),
                "index": .number(Double(index)), "total": .number(Double(total)),
                "data": .string(part.base64EncodedString()),
            ], timeout: 60)
            progress?(Double(index + 1) / Double(total))
        }
        guard result["attachmentId"] != nil else { throw AegisError.message("Upload didn’t finish") }
        return try result.decode(RemoteAttachment.self)
    }

    /// Journals, then sends a create/send/stop/permission command. If no answer
    /// comes back (lossy network, reconnect), the command stays in the journal as
    /// `.unknown` and `reconcile()` re-sends it until the Mac answers.
    @discardableResult
    /// `commandId` lets the caller show the command before it is answered.
    public func mutate(_ payload: [String: JSONValue], commandId: String = UUID().uuidString.lowercased()) async throws -> CommandResult {
        var request = payload
        request["id"] = .string(commandId)
        request["commandId"] = .string(commandId)
        request["expiresAt"] = .number((Self.now + serverOffset + remoteCommandLifetime).rounded())
        operations[commandId] = RemoteOperation(request: .object(request), result: CommandResult(commandId: commandId, state: .unknown))
        saveOperations()
        inFlight.insert(commandId)
        defer { inFlight.remove(commandId) }
        do {
            let result = try await self.request(request, timeout: 10).decode(CommandResult.self)
            settle(commandId, result)
            Task { await refresh() }
            return result
        } catch AegisError.rejected(let code) where code != "TOO_MANY_REQUESTS" {
            settle(commandId, CommandResult(commandId: commandId, state: .rejected, error: code))
            throw AegisError.rejected(code)
        } catch {
            // Not lost: the journal keeps it and reconcile() delivers it.
            return operations[commandId]?.result ?? CommandResult(commandId: commandId, state: .unknown)
        }
    }

    private func settle(_ commandId: String, _ result: CommandResult) {
        guard operations[commandId]?.result.unresolved == true else { return }
        operations[commandId]?.result = result
        saveOperations()
    }

    private func saveOperations() {
        // Keep the newest 100 entries plus anything still unresolved.
        let ordered = operations.sorted { ($0.value.request["expiresAt"]?.numberValue ?? 0) < ($1.value.request["expiresAt"]?.numberValue ?? 0) }
        for (id, operation) in ordered.dropLast(100) where !operation.result.unresolved {
            operations[id] = nil
        }
        // A file readable after first unlock: commands settle while the phone is locked too.
        if let data = try? JSONEncoder.aegis.encode(operations) { files.write(Self.journalFile, data) }
    }

    /// Called when the app returns to the foreground.
    /// Called when the app leaves the screen (switching apps or locking). The connection
    /// stays up while iOS lets the app run; the Mac is told so it keeps sending pushes.
    public func background() async {
        guard backgroundSince == nil else { return }
        backgroundSince = Self.now
        refreshTimer?.cancel()
        guard connection == .connected else { return }
        _ = try? await request(["method": "presence", "background": true], timeout: 3)
    }

    /// iOS is about to suspend the app: close cleanly so the Mac knows nobody is watching.
    public func suspend() async {
        guard backgroundSince != nil, pairing != nil else { return }
        await disconnect()
    }

    /// Called when the app returns to the foreground.
    public func foreground() async {
        let away = backgroundSince.map { Self.now - $0 } ?? 0
        backgroundSince = nil
        lastHeard = Self.now
        guard connection == .connected else {
            if pairing != nil, connection != .connecting, connection != .confirming { await connect() }
            return
        }
        // Longer than iOS keeps a background app running: the socket is gone, so don't wait on it.
        if away > Self.backgroundGrace * 1000 {
            await connect()
            return
        }
        do {
            _ = try await request(["method": "presence", "background": false], timeout: 3)
            await refresh()
        } catch AegisError.rejected {
            await refresh() // a Mac without presence support; the connection itself is fine
        } catch {
            await connect()
        }
    }

    /// How long the app keeps its connection after leaving the screen (seconds).
    public static let backgroundGrace: Double = 25

    /// Re-sends commands whose outcome is unknown, oldest first. Safe to repeat: the
    /// Mac runs a commandId once and answers a repeat with the first result, or with
    /// COMMAND_EXPIRED when it never arrived within its lifetime.
    public func reconcile() async {
        guard connection == .connected, !reconciling else { return }
        reconciling = true
        defer { reconciling = false }
        let waiting = operations
            .filter { $0.value.result.unresolved && !inFlight.contains($0.key) }
            .sorted { ($0.value.request["expiresAt"]?.numberValue ?? 0) < ($1.value.request["expiresAt"]?.numberValue ?? 0) }
        var delivered = false
        for (id, operation) in waiting {
            guard case .object(let request) = operation.request else { continue }
            inFlight.insert(id)
            defer { inFlight.remove(id) }
            do {
                settle(id, try await self.request(request, timeout: 10).decode(CommandResult.self))
                delivered = true
            } catch AegisError.rejected(let code) where code != "TOO_MANY_REQUESTS" {
                settle(id, CommandResult(commandId: id, state: .rejected, error: code))
            } catch {
                break
            }
        }
        if delivered { await refresh() }
    }

    public func clearError() { error = "" }
}
