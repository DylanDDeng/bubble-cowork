import CryptoKit
import Foundation

private let maxNoiseMessage = 65535
private let maxPlaintextChunk = 65535 - 16
private let maxAppFrame = 2 * 1024 * 1024
private let maxInbound = maxAppFrame * 4

/// Reassembles u16BE-prefixed Noise messages from wire frames.
private struct NoiseReader {
    var buffer = Data()

    mutating func next(from wire: WireConnection) async throws -> Data {
        while true {
            if buffer.count >= 2 {
                let length = Int(buffer[buffer.startIndex]) << 8 | Int(buffer[buffer.startIndex + 1])
                if buffer.count >= length + 2 {
                    let start = buffer.startIndex + 2
                    let message = buffer.subdata(in: start..<(start + length))
                    buffer = buffer.subdata(in: (start + length)..<buffer.endIndex)
                    return message
                }
            }
            switch try await wire.receive() {
            case .text:
                // Relay control frames never enter Noise.
                throw AegisError.connection("Unexpected relay control")
            case .binary(let data):
                buffer.append(data)
                if buffer.count > maxInbound { throw AegisError.connection("Inbound buffer exceeded") }
            }
        }
    }
}

private func lengthPrefixed16(_ body: Data) -> Data {
    Data([UInt8(body.count >> 8), UInt8(body.count & 0xff)]) + body
}

/// Encrypted, framed JSON channel over a relay connection (src/shared/remote/secure-channel.ts).
public actor SecureChannel {
    public nonisolated let remotePeerId: String
    /// Application messages (UTF-8 JSON bodies), in order.
    public nonisolated let messages: AsyncThrowingStream<Data, Error>

    private let wire: WireConnection
    private var sendCipher: CipherState
    private var closed = false
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var reader: Task<Void, Never>?

    private init(wire: WireConnection, remotePeerId: String, send: CipherState) {
        self.wire = wire
        self.remotePeerId = remotePeerId
        self.sendCipher = send
        var continuation: AsyncThrowingStream<Data, Error>.Continuation!
        messages = AsyncThrowingStream(bufferingPolicy: .bufferingOldest(128)) { continuation = $0 }
        self.continuation = continuation
    }

    /// Runs the XX handshake. The phone is the initiator and pins the desktop's peer id.
    public static func open(
        wire: WireConnection,
        identity: Identity,
        initiator: Bool,
        expectedPeer: String? = nil,
        timeout: TimeInterval = 10
    ) async throws -> SecureChannel {
        let key = try identity.signingKey()
        let expected = try expectedPeer.map { try PeerID.publicKey(from: $0) }
        let handshake = Task { () throws -> (CipherState, CipherState, String, Data) in
            var noise = NoiseHandshake(initiator: initiator, identity: key, expectedRemote: expected)
            var input = NoiseReader()
            if initiator {
                try await wire.send(.binary(lengthPrefixed16(try noise.writeA())))
                try noise.readB(try await input.next(from: wire))
                try await wire.send(.binary(lengthPrefixed16(try noise.writeC())))
            } else {
                try noise.readA(try await input.next(from: wire))
                try await wire.send(.binary(lengthPrefixed16(try noise.writeB())))
                try noise.readC(try await input.next(from: wire))
            }
            guard let remote = noise.remoteIdentity else { throw AegisError.handshake("Missing remote identity") }
            let (send, receive) = noise.split()
            return (send, receive, PeerID.string(for: remote), input.buffer)
        }
        let timer = Task {
            try? await Task.sleep(for: .seconds(timeout))
            if !Task.isCancelled {
                handshake.cancel()
                wire.close()
            }
        }
        defer { timer.cancel() }
        let result: (CipherState, CipherState, String, Data)
        do { result = try await handshake.value } catch {
            wire.close()
            if handshake.isCancelled { throw AegisError.handshake("Handshake timed out") }
            throw error
        }
        let channel = SecureChannel(wire: wire, remotePeerId: result.2, send: result.0)
        await channel.startReading(receive: result.1, leftover: result.3)
        return channel
    }

    private func startReading(receive: CipherState, leftover: Data) {
        let wire = self.wire
        let continuation = self.continuation
        reader = Task.detached { [weak self] in
            var cipher = receive
            var noise = NoiseReader(buffer: leftover)
            var pending = Data()
            do {
                while !Task.isCancelled {
                    let ciphertext = try await noise.next(from: wire)
                    pending.append(try cipher.decrypt(ciphertext))
                    while pending.count >= 4 {
                        let s = pending.startIndex
                        let length = Int(pending[s]) << 24 | Int(pending[s + 1]) << 16 | Int(pending[s + 2]) << 8 | Int(pending[s + 3])
                        guard length <= maxAppFrame else { throw AegisError.connection("Application frame too large") }
                        guard pending.count >= length + 4 else { break }
                        let body = pending.subdata(in: (s + 4)..<(s + 4 + length))
                        pending = pending.subdata(in: (s + 4 + length)..<pending.endIndex)
                        guard String(data: body, encoding: .utf8) != nil else { throw AegisError.connection("Invalid UTF-8") }
                        if case .dropped = continuation.yield(body) {
                            throw AegisError.connection("Application queue exceeded")
                        }
                    }
                }
            } catch {
                await self?.fail(error)
            }
        }
    }

    /// Sends one JSON message: u32BE length + body, encrypted in ≤65519-byte chunks.
    public func send(_ body: Data) async throws {
        guard !closed else { throw AegisError.connection("Connection closed") }
        guard body.count <= maxAppFrame else {
            fail(AegisError.connection("Outbound buffer exceeded"))
            throw AegisError.connection("Outbound buffer exceeded")
        }
        var frame = Data(capacity: body.count + 4)
        withUnsafeBytes(of: UInt32(body.count).bigEndian) { frame.append(contentsOf: $0) }
        frame.append(body)
        var offset = frame.startIndex
        // Encrypt every chunk before awaiting so concurrent sends can't interleave nonces.
        var messages: [Data] = []
        while offset < frame.endIndex {
            let end = min(offset + maxPlaintextChunk, frame.endIndex)
            let ciphertext = try sendCipher.encrypt(frame.subdata(in: offset..<end))
            precondition(ciphertext.count <= maxNoiseMessage)
            messages.append(lengthPrefixed16(ciphertext))
            offset = end
        }
        // Wire writes must follow nonce order. The actor is reentrant at `await`,
        // so chain each send after the previous one instead of writing directly.
        let previous = lastSend
        let wire = self.wire
        let task = Task {
            _ = await previous?.result
            for message in messages { try await wire.send(.binary(message)) }
        }
        lastSend = task
        do {
            try await task.value
        } catch {
            fail(error)
            throw error
        }
    }

    private var lastSend: Task<Void, Error>?

    public func sendJSON(_ value: JSONValue) async throws {
        try await send(try JSONEncoder.aegis.encode(value))
    }

    public func close() { fail(nil) }

    private func fail(_ error: Error?) {
        guard !closed else { return }
        closed = true
        reader?.cancel()
        continuation.finish(throwing: error)
        wire.close()
    }
}
