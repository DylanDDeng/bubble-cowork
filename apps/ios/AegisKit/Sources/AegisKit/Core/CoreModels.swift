import Foundation

// Render models produced by apps/ios/core (session.ts, index.ts). Keep in sync.

public struct SessionModel: Decodable, Equatable, Sendable {
    public let structured: Bool
    public let items: [SessionItem]
    public let lastAnswerText: String?

    public static let empty = SessionModel(structured: false, items: [], lastAnswerText: nil)
}

public struct Attachment: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let image: Bool
}

public struct ChangedFile: Decodable, Equatable, Sendable {
    public let path: String
    public let additions: Int
    public let deletions: Int
    /// The change record diff (often bare hunks).
    public let diff: String?

    /// The diff as a one-file patch the parser can read.
    public var patch: String? { Stage.File.wrap(diff, path: path) }
}

public enum SessionItem: Decodable, Equatable, Sendable, Identifiable {
    case user(id: String, prompt: String, attachments: [Attachment])
    case answer(id: String, markdown: String, streaming: Bool)
    case plan(id: String, markdown: String)
    case changes(id: String, files: [ChangedFile])
    case work(id: String, work: WorkBlock)
    case activity(id: String, steps: [Step])
    case working(id: String, label: String)

    public struct Step: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let detail: String
    }

    public var id: String {
        switch self {
        case .user(let id, _, _), .answer(let id, _, _), .plan(let id, _), .changes(let id, _),
             .work(let id, _), .activity(let id, _), .working(let id, _):
            return id
        }
    }

    private enum Keys: String, CodingKey { case kind, id, prompt, attachments, markdown, streaming, files, work, steps, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let id = try c.decode(String.self, forKey: .id)
        switch try c.decode(String.self, forKey: .kind) {
        case "user": self = .user(id: id, prompt: try c.decode(String.self, forKey: .prompt), attachments: try c.decode([Attachment].self, forKey: .attachments))
        case "answer": self = .answer(id: id, markdown: try c.decode(String.self, forKey: .markdown), streaming: try c.decode(Bool.self, forKey: .streaming))
        case "plan": self = .plan(id: id, markdown: try c.decode(String.self, forKey: .markdown))
        case "changes": self = .changes(id: id, files: try c.decode([ChangedFile].self, forKey: .files))
        case "work": self = .work(id: id, work: try c.decode(WorkBlock.self, forKey: .work))
        case "activity": self = .activity(id: id, steps: try c.decode([Step].self, forKey: .steps))
        default: self = .working(id: id, label: (try? c.decode(String.self, forKey: .label)) ?? "Working")
        }
    }
}

public struct WorkBlock: Decodable, Equatable, Sendable {
    /// "Worked for 1m 12s" / "3 previous messages"; nil when the block can't collapse.
    public let label: String?
    public let stoppedLabel: String?
    public let defaultExpanded: Bool
    public let groups: [WorkGroup]
    public let working: Bool
}

public enum WorkGroup: Decodable, Equatable, Sendable, Identifiable {
    case note(id: String, markdown: String, streaming: Bool)
    case thinking(id: String, label: String, active: Bool, text: String)
    case compaction(id: String, inProgress: Bool, label: String)
    case stages(StageGroup)

    public var id: String {
        switch self {
        case .note(let id, _, _), .thinking(let id, _, _, _), .compaction(let id, _, _): return id
        case .stages(let group): return group.id
        }
    }

    private enum Keys: String, CodingKey { case kind, id, markdown, streaming, label, active, text, inProgress }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "note":
            self = .note(id: try c.decode(String.self, forKey: .id), markdown: try c.decode(String.self, forKey: .markdown), streaming: try c.decode(Bool.self, forKey: .streaming))
        case "thinking":
            self = .thinking(id: try c.decode(String.self, forKey: .id), label: try c.decode(String.self, forKey: .label), active: try c.decode(Bool.self, forKey: .active), text: try c.decode(String.self, forKey: .text))
        case "compaction":
            self = .compaction(id: try c.decode(String.self, forKey: .id), inProgress: try c.decode(Bool.self, forKey: .inProgress), label: try c.decode(String.self, forKey: .label))
        default:
            self = .stages(try StageGroup(from: decoder))
        }
    }
}

public struct StageGroup: Decodable, Equatable, Sendable {
    public let id: String
    public let showHeader: Bool
    public let headerLabel: String
    public let headerIcon: String?
    public let headerActive: Bool
    public let failed: Int
    public let defaultOpen: Bool
    public let thinking: Bool
    public let stages: [Stage]
}

public struct Stage: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case row, subagents }
    public let id: String
    public let kind: Kind
    /// Desktop activity kind: explore, edit, command, approval, error, web, memory, other, computer_use…
    public let icon: String
    public let status: String
    public let title: String
    public let active: Bool
    public let expandable: Bool
    public let defaultOpen: Bool
    public let addedLines: Int
    public let removedLines: Int
    public let files: [File]
    public let commands: [Command]
    public let genericText: String
    public let lanes: [Lane]
    public let board: Board?

    public struct File: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let path: String
        public let addedLines: Int
        public let removedLines: Int
        /// Change record diff for edit stages; nil when the change isn't known.
        public let diff: String?

        /// The diff as a one-file patch. Tool diffs are often bare hunks, which
        /// the patch parser only reads under a file header.
        public var patch: String? { Self.wrap(diff, path: path) }

        /// Tool diffs are often bare hunks, which the patch parser only reads
        /// under a file header.
        static func wrap(_ diff: String?, path: String) -> String? {
            guard let diff, !diff.isEmpty else { return nil }
            if diff.hasPrefix("diff --git") || diff.hasPrefix("--- ") || diff.contains("\n+++ ") { return diff }
            return "--- a/\(path)\n+++ b/\(path)\n" + diff
        }
    }
    public struct Command: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let isError: Bool
    }
    public struct Lane: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let provider: String?
        public let label: String
        /// running, finished, failed, interrupted
        public let status: String
    }
    public struct Board: Decodable, Equatable, Sendable {
        public let title: String
        public let meta: String
    }
}

/// Agent catalog for one provider, with per-model reasoning options.
public struct AgentCatalog: Decodable, Equatable, Sendable {
    public struct Model: Decodable, Equatable, Hashable, Sendable {
        public let value: String
        public let label: String
        public let description: String?
        public let compatibleProviderId: String?
    }
    public struct Effort: Decodable, Equatable, Hashable, Sendable {
        public let value: String
        public let label: String
    }
    public struct ModelOptions: Decodable, Equatable, Sendable {
        public let efforts: [Effort]
        public let defaultEffort: String?
        public let fast: Bool
    }
    public struct PermissionMode: Decodable, Equatable, Hashable, Sendable {
        public let mode: String
        public let label: String
        /// "full-access" / "danger" modes are shown in red.
        public let tone: String?
        public var isFullAccess: Bool { tone == "full-access" || tone == "danger" }
    }

    public let provider: String
    public let models: [Model]
    public let defaultModel: String
    public let perModel: [String: ModelOptions]
    /// Display names for models sessions use that aren't in `models`.
    public var labels: [String: String]? = nil
    public let permissionModes: [PermissionMode]
    public let defaultPermission: String
    public let supportsPlan: Bool

    public static func placeholder(_ provider: String) -> AgentCatalog {
        AgentCatalog(provider: provider, models: [], defaultModel: "", perModel: [:], permissionModes: [],
                     defaultPermission: "default", supportsPlan: true)
    }

    public func options(for model: String) -> ModelOptions {
        perModel[model] ?? ModelOptions(efforts: [], defaultEffort: nil, fast: false)
    }
}

/// Effective settings with defaults filled in (mirrors resolveSettings in apps/ios/core/agents.ts).
public struct ResolvedSettings: Equatable, Sendable {
    public let model: String
    public let modelLabel: String
    public let compatibleProviderId: String?
    public let efforts: [AgentCatalog.Effort]
    public let effort: String?
    public let effortLabel: String?
    /// The effort the slider shows: the chosen one or the model's default.
    public let shownEffort: String?
    public let fastAvailable: Bool
    public let fast: Bool
    public let permissionMode: String
    public let permission: AgentCatalog.PermissionMode?
    public let plan: Bool

    public var isFullAccess: Bool { permission?.isFullAccess == true }
}

extension AgentCatalog {
    public func resolve(_ settings: RemoteTaskSettings) -> ResolvedSettings {
        let model = settings.model ?? defaultModel
        let choice = models.first { $0.value == model && $0.compatibleProviderId == settings.compatibleProviderId }
            ?? models.first { $0.value == model }
        let options = options(for: model)
        let effort = settings.effort.flatMap { e in options.efforts.contains { $0.value == e } ? e : nil } ?? options.defaultEffort
        let permissionMode = permissionModes.contains { $0.mode == settings.permissionMode } ? settings.permissionMode! : defaultPermission
        return ResolvedSettings(
            model: model,
            modelLabel: choice?.label ?? labels?[model] ?? (model.isEmpty ? "Default" : model),
            compatibleProviderId: choice?.compatibleProviderId,
            efforts: options.efforts,
            effort: effort,
            effortLabel: effort.map { e in options.efforts.first { $0.value == e }?.label ?? e },
            shownEffort: effort ?? options.defaultEffort,
            fastAvailable: options.fast,
            fast: options.fast && settings.fast == true,
            permissionMode: permissionMode,
            permission: permissionModes.first { $0.mode == permissionMode },
            plan: supportsPlan && settings.plan == true
        )
    }

    /// Request payload: only what the user chose, so the Mac keeps its defaults otherwise.
    public func requestSettings(_ settings: RemoteTaskSettings) -> JSONValue {
        let r = resolve(settings)
        var out: [String: JSONValue] = ["permissionMode": .string(r.permissionMode), "plan": .bool(r.plan)]
        if !r.model.isEmpty { out["model"] = .string(r.model) }
        if let id = r.compatibleProviderId { out["compatibleProviderId"] = .string(id) }
        if settings.effort != nil, let effort = r.effort { out["effort"] = .string(effort) }
        if r.fastAvailable { out["fast"] = .bool(r.fast) }
        return .object(out)
    }
}

public struct DiffFile: Decodable, Equatable, Sendable {
    public struct Line: Decodable, Equatable, Sendable {
        /// add, del, ctx, hunk
        public let type: String
        public let oldNo: Int?
        public let newNo: Int?
        public let text: String

        public init(type: String, oldNo: Int?, newNo: Int?, text: String) {
            self.type = type
            self.oldNo = oldNo
            self.newNo = newNo
            self.text = text
        }
    }
    public let path: String
    public let additions: Int
    public let deletions: Int
    public let lines: [Line]
}

/// A permission request split into its main body and small facts.
public struct RequestDescription: Decodable, Equatable, Sendable {
    public let label: String
    public let body: String
    public let fields: [[String]]
    public let summary: String
}
