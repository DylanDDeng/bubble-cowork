import Foundation
import Testing
@testable import AegisKit

/// Repository root (apps/ios/AegisKit/Tests/AegisKitTests → five levels up).
let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

/// A child node process with line-oriented stdout.
final class NodeProcess: @unchecked Sendable {
    let process = Process()
    private let stdin = Pipe()
    private let stdout = Pipe()
    private var buffer = Data()
    private var lines: [String] = []
    private let lock = NSLock()

    init(_ arguments: [String], environment: [String: String] = [:]) throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node"] + arguments
        process.currentDirectoryURL = repoRoot
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = (env["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin"
        environment.forEach { env[$0.key] = $0.value }
        process.environment = env
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.standardError
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty else { return }
            self.lock.withLock {
                self.buffer.append(data)
                while let newline = self.buffer.firstIndex(of: 0x0a) {
                    self.lines.append(String(decoding: self.buffer[..<newline], as: UTF8.self))
                    self.buffer.removeSubrange(...newline)
                }
            }
        }
        try process.run()
    }

    func write(_ line: String) { stdin.fileHandleForWriting.write(Data((line + "\n").utf8)) }

    /// Waits for the next stdout line that parses as a JSON object with `key`.
    func json(_ key: String, timeout: TimeInterval = 20) async throws -> JSONValue {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let found: JSONValue? = lock.withLock {
                if let i = lines.firstIndex(where: { (try? JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)))?[key] != nil }) {
                    return try? JSONDecoder().decode(JSONValue.self, from: Data(lines.remove(at: i).utf8))
                }
                return nil
            }
            if let found { return found }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw AegisError.message("node did not print \(key)")
    }

    func line(containing text: String, timeout: TimeInterval = 20) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = lock.withLock({ lines.first { $0.contains(text) } }) { return hit }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw AegisError.message("node did not print \(text)")
    }

    deinit { if process.isRunning { process.terminate() } }
}

@Suite(.serialized) struct InteropTests {
    @Test func swiftInitiatorTalksToDesktopNoise() async throws {
        let node = try NodeProcess(["apps/ios/AegisKit/Tests/interop/noise-peer.mjs", "responder"])
        let ready = try await node.json("port")
        let port = Int(ready["port"]!.numberValue!)
        let desktopPeer = ready["peerId"]!.stringValue!
        let socket = RelaySocket(url: URL(string: "ws://127.0.0.1:\(port)")!)
        try await socket.waitOpen()
        let phone = Identity.create()
        let channel = try await SecureChannel.open(wire: socket, identity: phone, initiator: true, expectedPeer: desktopPeer)
        #expect(channel.remotePeerId == desktopPeer)
        #expect(try await node.json("remote")["remote"]?.stringValue == phone.peerId)

        var messages = channel.messages.makeAsyncIterator()
        let big = String(repeating: "é", count: 90_000) // multi-byte UTF-8 across chunk borders
        try await channel.sendJSON(.object(["type": "hello", "body": .string(big)]))
        let echo = try JSONDecoder().decode(JSONValue.self, from: try #require(try await messages.next()))
        #expect(echo["echo"]?["body"]?.stringValue == big)
        try await channel.sendJSON(.object(["type": "bye"]))
        _ = try await messages.next()
        await channel.close()
    }

    @Test func desktopInitiatorPinsSwiftIdentity() async throws {
        let node = try NodeProcess(["apps/ios/AegisKit/Tests/interop/noise-peer.mjs", "initiator"])
        let ready = try await node.json("port")
        let swiftSide = Identity.create()
        node.write(swiftSide.peerId)
        let socket = RelaySocket(url: URL(string: "ws://127.0.0.1:\(Int(ready["port"]!.numberValue!))")!)
        try await socket.waitOpen()
        let channel = try await SecureChannel.open(wire: socket, identity: swiftSide, initiator: false)
        #expect(channel.remotePeerId == ready["peerId"]?.stringValue)
        try await channel.sendJSON(.object(["type": "bye"]))
        var messages = channel.messages.makeAsyncIterator()
        let echo = try JSONDecoder().decode(JSONValue.self, from: try #require(try await messages.next()))
        #expect(echo["echo"]?["type"]?.stringValue == "bye")
        await channel.close()
    }
}
