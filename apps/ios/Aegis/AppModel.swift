import AegisKit
import Observation
import SwiftUI
import UserNotifications

/// A photo or file picked in the composer, uploaded to the Mac before sending.
@Observable
final class PendingAttachment: Identifiable {
    let id = UUID().uuidString
    let name: String
    let image: UIImage?
    var progress: Double = 0
    var attachmentId: String?
    var error: String?

    init(name: String, image: UIImage?) {
        self.name = name
        self.image = image
    }

    var uploading: Bool { attachmentId == nil && error == nil }
}

/// App state around the RemoteClient: navigation, preferences, drafts, sending.
@MainActor
@Observable
final class AppModel {
    enum Screen: Hashable { case home, session(String) }
    enum Route: Hashable {
        case projects, project(String), settings
    }

    let client: RemoteClient
    let core = CoreScript.shared

    // Navigation
    var screen: Screen = .home
    var path: [Route] = []
    var drawerOpen = false
    /// Wide layout (an unfolded iPhone Duo): the sidebar is docked beside the page.
    var wideLayout = false
    /// The docked sidebar, hidden with the sidebar button.
    var sidebarHidden = false
    var approval: RemotePermission?
    var pairOpen = false
    var pairText = ""

    // Activity
    var busy = false
    var notice = ""
    var notificationStatus: UNAuthorizationStatus = .notDetermined
    /// Increments on send; the conversation jumps to the bottom.
    var sendTick = 0
    var attachments: [PendingAttachment] = []

    /// The diff sheet, when open.
    var diffReview: DiffReview?

    // Agent catalogs from the Mac, per provider.
    var catalogs: [String: AgentCatalog] = [:]

    // Preferences
    var provider: String { didSet { defaults.set(provider, forKey: "aegis-provider") } }
    var projectId: String { didSet { defaults.set(projectId, forKey: "aegis-project") } }
    var worktree: Bool { didSet { defaults.set(worktree, forKey: "aegis-worktree") } }
    var theme: String { didSet { defaults.set(theme, forKey: "aegis-theme") } }
    private(set) var taskSettings: [String: RemoteTaskSettings]
    private(set) var sessionSettings: [String: RemoteTaskSettings]

    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var drafts: [String: String] = [:]
    private(set) var draftVersion = 0

    init(client: RemoteClient? = nil) {
        let environment: RemoteEnvironment = (Bundle.main.bundleIdentifier ?? "").hasSuffix(".dev") ? .development : .production
        self.client = client ?? RemoteClient(environment: environment)
        provider = defaults.string(forKey: "aegis-provider") ?? "claude"
        projectId = defaults.string(forKey: "aegis-project") ?? ""
        worktree = defaults.bool(forKey: "aegis-worktree")
        theme = defaults.string(forKey: "aegis-theme") ?? "system"
        taskSettings = Self.load("aegis-task-settings") ?? [:]
        sessionSettings = Self.load("aegis-session-settings") ?? [:]
    }

    private static func load<T: Decodable>(_ key: String) -> T? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private func save<T: Encodable>(_ value: T, _ key: String) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
    }

    // MARK: Derived state

    var snapshot: RemoteSnapshot? { client.snapshot }
    var sessions: [RemoteSession] { snapshot?.sessions ?? [] }
    var projects: [RemoteProject] { snapshot?.projects ?? [] }
    var permissions: [RemotePermission] { snapshot?.permissions ?? [] }
    var ready: Bool { client.connection == .connected }
    var paired: Bool { client.pairing != nil && !(client.connection == .confirming && snapshot == nil) }
    var macName: String {
        let name = snapshot?.machineName ?? client.pairing?.name ?? "Your Mac"
        return name.hasSuffix(".local") ? String(name.dropLast(6)) : name
    }
    var connectionText: String {
        switch client.connection {
        case .connected: return client.freshness == .current ? "Synced" : "Updating…"
        case .offline: return "Offline"
        default: return "Connecting…"
        }
    }
    var environmentLabel: String { client.pairing?.environment.label ?? client.environment.label }
    var selectedProject: RemoteProject? { projects.first { $0.id == projectId } ?? projects.first }
    var currentSessionId: String? {
        if case .session(let id) = screen { return id }
        return nil
    }
    var currentSession: RemoteSession? { sessions.first { $0.id == currentSessionId } }
    var unresolvedCount: Int { client.operations.values.filter(\.result.unresolved).count }

    func catalog(_ provider: String) -> AgentCatalog { catalogs[provider] ?? .placeholder(provider) }

    func reloadCatalogs() async {
        for provider in agentProviders {
            catalogs[provider] = await core.catalog(provider: provider, options: client.agentOptions, extraModels: sessionModels[provider] ?? [])
        }
    }

    /// Models the Mac's sessions run on, per provider; the catalog resolves these too.
    var sessionModels: [String: [String]] {
        Dictionary(grouping: sessions.compactMap { s in s.settings?.model.map { (s.provider, $0) } }, by: \.0)
            .mapValues { Array(Set($0.map(\.1))).sorted() }
    }

    // MARK: Settings for the composer

    var newSettings: RemoteTaskSettings { taskSettings[provider] ?? RemoteTaskSettings() }

    func setNewSettings(_ value: RemoteTaskSettings) {
        taskSettings[provider] = value
        save(taskSettings, "aegis-task-settings")
    }

    func settings(forSession id: String) -> RemoteTaskSettings {
        sessionSettings[id] ?? sessions.first { $0.id == id }?.settings ?? RemoteTaskSettings()
    }

    func setSettings(_ value: RemoteTaskSettings, forSession id: String) {
        sessionSettings[id] = value
        save(sessionSettings, "aegis-session-settings")
    }

    func describe(_ provider: String) -> String {
        let r = catalog(provider).resolve(taskSettings[provider] ?? RemoteTaskSettings())
        return r.modelLabel + (r.effortLabel.map { " · \($0)" } ?? "")
    }

    // MARK: Drafts (files, written on every change)

    private var draftKey: String { client.draftName(currentSessionId ?? "new") }

    var draft: String {
        get {
            _ = draftVersion
            if let cached = drafts[draftKey] { return cached }
            let stored = client.files.read(draftKey).map { String(decoding: $0, as: UTF8.self) } ?? ""
            drafts[draftKey] = stored
            return stored
        }
        set {
            drafts[draftKey] = newValue
            if newValue.isEmpty { client.files.remove(draftKey) } else { client.files.write(draftKey, Data(newValue.utf8)) }
            draftVersion += 1
        }
    }

    // MARK: Navigation

    func openHome() {
        drawerOpen = false
        path = []
        screen = .home
        attachments = []
        client.select(nil)
    }

    func open(session id: String) {
        drawerOpen = false
        path = []
        screen = .session(id)
        attachments = []
        client.select(id)
    }

    func push(_ route: Route) {
        drawerOpen = false
        path.append(route)
    }

    /// Parses an edit stage's file diffs (one file per entry, in stage order).
    func diffFiles(for stage: Stage) async -> [DiffFile] {
        var files: [DiffFile] = []
        for file in stage.files {
            guard let patch = file.patch else { continue }
            files += await core.parsePatch(patch)
        }
        return files
    }

    func openStageDiff(_ stage: Stage, file: Stage.File) async {
        let files = await diffFiles(for: stage)
        guard !files.isEmpty else { return }
        let focus = files.first { $0.path == file.path || $0.path.hasSuffix("/" + file.name) || file.path.hasSuffix($0.path) }
        diffReview = DiffReview(files: files, focus: focus?.path, projectId: currentSession?.projectId)
    }

    /// Opens a turn's changed files, scrolled to `focus` when given.
    func openTurnDiff(_ changed: [ChangedFile], focus: String?) async {
        var files: [DiffFile] = []
        for file in changed {
            guard let patch = file.patch else { continue }
            files += await core.parsePatch(patch)
        }
        guard !files.isEmpty else { return }
        let match = focus.flatMap { f in files.first { $0.path == f || f.hasSuffix("/" + $0.path) || $0.path.hasSuffix("/" + f) } }
        diffReview = DiffReview(files: files, focus: match?.path, projectId: currentSession?.projectId)
    }

    func newTask(in project: String? = nil) {
        if let project { projectId = project }
        openHome()
    }

    // MARK: Actions

    func perform(_ action: @escaping () async throws -> Void) async {
        busy = true
        notice = ""
        defer { busy = false }
        do { try await action() } catch {
            notice = error.localizedDescription
            Haptics.warning()
        }
    }

    func pair(_ value: String) async {
        await perform {
            try await self.client.pair(value)
            self.pairOpen = false
            self.pairText = ""
        }
    }

    var attachmentsReady: Bool { attachments.allSatisfy { $0.attachmentId != nil } }

    func addAttachment(name: String, data: Data, image: UIImage?) {
        let item = PendingAttachment(name: name, image: image)
        attachments.append(item)
        guard data.count <= 10 * 1024 * 1024 else {
            item.error = "Larger than 10 MB"
            return
        }
        Task {
            do {
                let result = try await client.upload(name: name, bytes: data) { item.progress = $0 }
                item.attachmentId = result.attachmentId
                item.progress = 1
            } catch {
                item.error = error.localizedDescription
            }
        }
    }

    func removeAttachment(_ id: String) { attachments.removeAll { $0.id == id } }

    var canSend: Bool {
        guard ready, !busy, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, attachmentsReady else { return false }
        return currentSessionId != nil || selectedProject != nil
    }

    func send() async {
        let prompt = draft
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let sessionId = currentSessionId
        await perform {
            let pending = self.client.operations.values.contains { op in
                op.result.unresolved && (sessionId != nil ? op.sessionId == sessionId : op.method == "create")
            }
            if pending { throw AegisError.message("Your previous message is still on its way to your Mac.") }
            if sessionId == nil, self.selectedProject == nil { throw AegisError.message("Choose a project first.") }
            if !self.attachmentsReady { throw AegisError.message("Wait for attachments to finish uploading.") }
            let ids = self.attachments.compactMap(\.attachmentId)
            self.sendTick += 1
            var request: [String: JSONValue]
            if let sessionId, let session = self.currentSession {
                request = [
                    "method": "send", "sessionId": .string(sessionId), "prompt": .string(prompt),
                    "settings": self.catalog(session.provider).requestSettings(self.settings(forSession: sessionId)),
                ]
            } else {
                request = [
                    "method": "create", "projectId": .string(self.selectedProject!.id), "provider": .string(self.provider),
                    "prompt": .string(prompt), "settings": self.catalog(self.provider).requestSettings(self.newSettings),
                ]
                if self.worktree { request["worktree"] = true }
            }
            if !ids.isEmpty { request["attachmentIds"] = .array(ids.map { .string($0) }) }
            let result = try await self.client.mutate(request)
            switch result.state {
            case .completed:
                self.draft = ""
                self.attachments = []
                Haptics.success()
                if sessionId == nil, let created = result.sessionId {
                    self.open(session: created)
                    if self.notificationStatus == .notDetermined { Task { await self.requestNotifications() } }
                }
            case .rejected:
                self.notice = result.error == "SESSION_BUSY"
                    ? "This task is already running on your Mac. Your message is kept as a draft."
                    : (result.error ?? "Your Mac didn’t accept this.")
            default:
                // Kept in the journal and re-sent until the Mac answers; the bubble shows "Sending…".
                self.draft = ""
                self.attachments = []
            }
        }
    }

    func stop() async {
        guard let session = currentSession, let runId = session.runId else { return }
        await perform {
            try await self.client.mutate(["method": "stop", "sessionId": .string(session.id), "runId": .string(runId)])
        }
    }

    func decide(_ permission: RemotePermission, _ decision: String) async {
        await perform {
            try await self.client.mutate([
                "method": "permission", "sessionId": .string(permission.sessionId), "runId": .string(permission.runId),
                "requestId": .string(permission.requestId), "decision": .string(decision),
            ])
            self.approval = nil
        }
    }

    // MARK: Background

    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundTimer: Task<Void, Never>?

    /// Off screen (another app, or locked): keep the connection for a short grace so a
    /// quick switch back needs no reconnect, then close it cleanly before iOS suspends us.
    func beginBackground() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Aegis connection") { [weak self] in
            // iOS wants the task ended before this handler returns; the close is best effort.
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { await self.client.suspend() }
                self.endBackground()
            }
        }
        Task { await client.background() }
        backgroundTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(RemoteClient.backgroundGrace))
            guard !Task.isCancelled else { return }
            self?.finishBackground()
        }
    }

    func endBackground() {
        backgroundTimer?.cancel()
        backgroundTimer = nil
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    private func finishBackground() {
        let task = backgroundTask
        guard task != .invalid else { return }
        backgroundTimer?.cancel()
        backgroundTimer = nil
        Task {
            await client.suspend()
            if backgroundTask == task {
                UIApplication.shared.endBackgroundTask(task)
                backgroundTask = .invalid
            }
        }
    }

    func removeMac() async {
        await client.disconnect(forget: true)
        drafts = [:]
        path = []
        screen = .home
    }

    func dismissNotice() {
        notice = ""
        client.clearError()
    }
}
