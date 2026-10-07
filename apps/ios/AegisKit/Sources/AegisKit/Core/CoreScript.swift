import Foundation
import JavaScriptCore

/// Runs the shared desktop view logic (aegis-core.js, built from apps/ios/core)
/// in one JavaScriptCore context on its own serial queue.
public final class CoreScript: @unchecked Sendable {
    public static let shared = CoreScript()

    private let queue = DispatchQueue(label: "ai.aegis.core-script", qos: .userInitiated)
    private var context: JSContext?
    private var api: JSValue?
    private var lastSession: (key: Int, model: SessionModel)?

    public init(source: String? = nil) {
        queue.async {
            let context = JSContext()
            context?.exceptionHandler = { _, exception in
                NSLog("aegis-core exception: %@", exception?.toString() ?? "unknown")
            }
            let script = source ?? Bundle.module.url(forResource: "aegis-core", withExtension: "js")
                .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
            if let script { context?.evaluateScript(script) }
            self.context = context
            self.api = context?.objectForKeyedSubscript("AegisCore")
        }
    }

    private struct ScriptError: Decodable { let error: String }

    /// Calls `AegisCore[name](json)` and decodes the JSON result.
    private func call<T: Decodable>(_ name: String, _ input: some Encodable, as type: T.Type) throws -> T {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let fn = api?.objectForKeyedSubscript(name), !fn.isUndefined else {
            throw AegisError.message("Core script unavailable")
        }
        let json = String(decoding: try JSONEncoder.aegis.encode(input), as: UTF8.self)
        guard let output = fn.call(withArguments: [json])?.toString() else { throw AegisError.message("Core script failed") }
        let data = Data(output.utf8)
        if let failure = try? JSONDecoder().decode(ScriptError.self, from: data) { throw AegisError.message(failure.error) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try work() }) }
        }
    }

    private struct SessionInput: Encodable {
        let messages: [RemoteMessage]
        let running: Bool
        let status: String
    }

    /// The session render model. Repeated calls with the same input reuse the last result.
    public func renderSession(messages: [RemoteMessage], running: Bool, status: String) async -> SessionModel {
        var hasher = Hasher()
        hasher.combine(messages)
        hasher.combine(running)
        hasher.combine(status)
        let key = hasher.finalize()
        do {
            return try await run {
                if let last = self.lastSession, last.key == key { return last.model }
                let model = try self.call("renderSession", SessionInput(messages: messages, running: running, status: status), as: SessionModel.self)
                self.lastSession = (key, model)
                return model
            }
        } catch {
            NSLog("renderSession failed: %@", String(describing: error))
            return Self.plainText(messages, running: running, status: status)
        }
    }

    /// Fallback when the script fails: text rows only.
    static func plainText(_ messages: [RemoteMessage], running: Bool, status: String) -> SessionModel {
        var items: [SessionItem] = messages.compactMap { m in
            if m.role == "user" { return .user(id: m.id, prompt: m.text, attachments: []) }
            if m.role == "assistant", !m.text.isEmpty { return .answer(id: m.id, markdown: m.text, streaming: m.streaming == true) }
            return nil
        }
        if running { items.append(.working(id: "working", label: status == "stopping" ? "Stopping…" : "Working")) }
        return SessionModel(structured: false, items: items, lastAnswerText: messages.last { $0.role == "assistant" }?.text)
    }

    private struct CatalogInput: Encodable {
        let provider: String
        let options: JSONValue?
        let extraModels: [String]
    }

    /// `extraModels`: models existing sessions use, so their options and labels resolve
    /// even when the Mac's list doesn't carry them.
    public func catalog(provider: String, options: JSONValue?, extraModels: [String] = []) async -> AgentCatalog {
        (try? await run { try self.call("catalog", CatalogInput(provider: provider, options: options, extraModels: extraModels), as: AgentCatalog.self) })
            ?? .placeholder(provider)
    }

    public func parsePatch(_ patch: String) async -> [DiffFile] {
        (try? await run { try self.call("parsePatch", ["patch": patch], as: [DiffFile].self) }) ?? []
    }

    public func describeRequest(_ detail: String) async -> RequestDescription {
        (try? await run { try self.call("describeRequest", ["detail": detail], as: RequestDescription.self) })
            ?? RequestDescription(label: "Request", body: detail, fields: [], summary: detail)
    }
}
