import Foundation
import Testing
@testable import AegisKit

/// Runs RemoteClient against scripts/remote/fixture.mjs: the desktop gateway and
/// relay with a deterministic fake runtime (needs `npm run transpile:electron`).
@Suite(.serialized) @MainActor struct ClientEndToEndTests {
    private func waitUntil(_ timeout: TimeInterval = 20, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { throw AegisError.message("timed out") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    @Test func pairsReadsAndMutatesAgainstFixtureHost() async throws {
        let port = Int.random(in: 20000...40000)
        let offerFile = FileManager.default.temporaryDirectory.appendingPathComponent("aegis-offer-\(port).txt")
        let fixture = try NodeProcess(["scripts/remote/fixture.mjs"], environment: [
            "AEGIS_FIXTURE_PORT": String(port), "AEGIS_FIXTURE_OFFER": offerFile.path,
        ])
        _ = try await fixture.line(containing: "Isolated UI fixture ready")
        let offer = try String(contentsOf: offerFile, encoding: .utf8)

        let files = FileStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("aegis-e2e-\(port)"))
        let secrets = MemoryStore()
        let client = RemoteClient(environment: .fixture, secrets: secrets, files: files)
        try await client.pair(offer)
        try await waitUntil { client.connection == .connected && client.snapshot != nil && client.agentOptions != nil }

        let snapshot = try #require(client.snapshot)
        #expect(snapshot.environment == .fixture)
        #expect(snapshot.projects.map(\.id) == ["project", "site"])
        #expect(snapshot.sessions.contains { $0.id == "stream" && $0.handoffSourceProvider == "claude" })
        #expect(client.pairing?.invite == nil) // claimed invites are dropped after auth
        #expect(try secrets.get("identity") != nil)

        // History for a session.
        client.select("design")
        try await waitUntil { client.messagesBySession["design"]?.messages?.isEmpty == false }

        // Approval, as the approval sheet sends it.
        let permission = try #require(snapshot.permissions.first)
        let decided = try await client.mutate([
            "method": "permission", "sessionId": .string(permission.sessionId), "runId": .string(permission.runId),
            "requestId": .string(permission.requestId), "decision": "allow",
        ])
        #expect(decided.state == .completed)

        // Chunked upload (two chunks) and a new task carrying it plus settings.
        let attachment = try await client.upload(name: "notes.txt", bytes: Data(repeating: 65, count: attachmentChunkBytes + 10))
        #expect(attachment.size == Double(attachmentChunkBytes + 10))
        let created = try await client.mutate([
            "method": "create", "projectId": "project", "provider": "codex", "prompt": "Ship it",
            "settings": .object(["model": "gpt-5", "effort": "high", "permissionMode": "fullAccess", "plan": true]),
            "worktree": true, "attachmentIds": .array([.string(attachment.attachmentId)]),
        ])
        #expect(created.state == .completed)
        let started = try await fixture.line(containing: "fixture start")
        #expect(started.contains("\"effort\":\"high\"") && started.contains("notes.txt") && started.contains("\"worktree\":true"))
        let newSession = try #require(created.sessionId)
        try await waitUntil { client.snapshot?.sessions.contains { $0.id == newSession } == true }

        // Journal: a resolved command stays resolved after reconcile.
        await client.reconcile()
        #expect(client.operations.values.allSatisfy { !$0.result.unresolved })

        // Forgetting clears the pairing and journal but keeps the identity.
        await client.disconnect(forget: true)
        #expect(client.connection == .unpaired)
        #expect(try secrets.get("pairing") == nil)
        #expect(try secrets.get("identity") != nil)
        fixture.process.terminate()
    }
}
