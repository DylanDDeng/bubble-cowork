import CryptoKit
import Foundation
import Testing
@testable import AegisKit

@Suite struct CryptoTests {
    @Test func peerIdMatchesLibp2pVector() throws {
        // Vector produced by @libp2p/crypto + @libp2p/peer-id for seed = 32 × 0x07.
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let identity = Identity.make(key)
        #expect(identity.peerId == "12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7")
        let pb = Data(base64Encoded: identity.privateKey)!
        #expect(pb.prefix(4) == Data([0x08, 0x01, 0x12, 0x40]))
        #expect(pb.suffix(32).map { String(format: "%02x", $0) }.joined().hasPrefix("ea4a6c63e29c520a"))
        #expect(try identity.signingKey().rawRepresentation == key.rawRepresentation)
        #expect(try PeerID.publicKey(from: identity.peerId) == key.publicKey.rawRepresentation)
    }

    @Test func base58RoundTrip() {
        for bytes in [Data(), Data([0]), Data([0, 0, 1, 2]), Data((0..<64).map { UInt8($0 * 3 & 0xff) })] {
            #expect(Base58.decode(Base58.encode(bytes)) == bytes)
        }
        #expect(Base58.decode("0OIl") == nil)
    }

    @Test func swiftHandshakeBothRoles() async throws {
        let (a, b) = PipeWire.pair()
        let phone = Identity.create()
        let mac = Identity.create()
        async let macChannel = SecureChannel.open(wire: b, identity: mac, initiator: false)
        let phoneChannel = try await SecureChannel.open(wire: a, identity: phone, initiator: true, expectedPeer: mac.peerId)
        let host = try await macChannel
        #expect(phoneChannel.remotePeerId == mac.peerId)
        #expect(host.remotePeerId == phone.peerId)

        // 300 KB spans several 65519-byte Noise chunks.
        let big = String(repeating: "x", count: 300_000)
        try await phoneChannel.sendJSON(.object(["type": "hello", "body": .string(big)]))
        var iterator = host.messages.makeAsyncIterator()
        let received = try JSONDecoder().decode(JSONValue.self, from: try #require(try await iterator.next()))
        #expect(received["body"]?.stringValue?.count == 300_000)
        try await host.sendJSON(.object(["type": "reply"]))
        var phoneIterator = phoneChannel.messages.makeAsyncIterator()
        let reply = try JSONDecoder().decode(JSONValue.self, from: try #require(try await phoneIterator.next()))
        #expect(reply["type"]?.stringValue == "reply")
    }

    @Test func concurrentLargeSendsStayInNonceOrder() async throws {
        let (a, b) = PipeWire.pair()
        let mac = Identity.create()
        async let host = SecureChannel.open(wire: b, identity: mac, initiator: false)
        let phone = try await SecureChannel.open(wire: a, identity: Identity.create(), initiator: true, expectedPeer: mac.peerId)
        let receiver = try await host
        // Several multi-chunk messages sent at once must not interleave on the wire.
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<6 {
                group.addTask { try await phone.sendJSON(.object(["i": .number(Double(i)), "body": .string(String(repeating: "z", count: 150_000))])) }
            }
            try await group.waitForAll()
        }
        var seen = Set<Int>()
        for try await body in receiver.messages {
            seen.insert(Int(try JSONDecoder().decode(JSONValue.self, from: body)["i"]!.numberValue!))
            if seen.count == 6 { break }
        }
        #expect(seen == Set(0..<6))
    }

    @Test func rejectsUnexpectedDesktop() async throws {
        let (a, b) = PipeWire.pair()
        async let host = SecureChannel.open(wire: b, identity: Identity.create(), initiator: false)
        await #expect(throws: AegisError.handshake("Unexpected desktop identity")) {
            _ = try await SecureChannel.open(wire: a, identity: Identity.create(), initiator: true, expectedPeer: Identity.create().peerId)
        }
        _ = try? await host
    }

    @Test func pairingParsing() throws {
        let offer = #"{"version":1,"environment":"development","relay":"ws://127.0.0.1:8788","room":"0123456789abcdef0123456789abcdef","routeToken":"\#(String(repeating: "a", count: 64))","hostPeerId":"12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7","invite":"\#(String(repeating: "b", count: 64))","expiresAt":\#(Date().timeIntervalSince1970 * 1000 + 60000),"name":"Mac"}"#
        let link = "aegis-dev://pair#" + offer.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        #expect(try Pairing.parse(link).room == "0123456789abcdef0123456789abcdef")
        #expect(throws: AegisError.message("The relay must use WSS.")) {
            try Pairing.parse(offer.replacingOccurrences(of: "ws://127.0.0.1:8788", with: "ws://example.com"))
        }
        #expect(throws: AegisError.message("This pairing code expired. Generate a new one on your Mac.")) {
            try Pairing.parse(offer, now: Date().addingTimeInterval(3600))
        }
    }
}

/// In-memory message pipe standing in for the relay.
final class PipeWire: WireConnection, @unchecked Sendable {
    private let inbox: AsyncThrowingStream<WireMessage, Error>
    private let inboxContinuation: AsyncThrowingStream<WireMessage, Error>.Continuation
    weak var peer: PipeWire?
    private var iterator: AsyncThrowingStream<WireMessage, Error>.AsyncIterator

    private init() {
        var c: AsyncThrowingStream<WireMessage, Error>.Continuation!
        inbox = AsyncThrowingStream { c = $0 }
        inboxContinuation = c
        iterator = inbox.makeAsyncIterator()
    }

    static func pair() -> (PipeWire, PipeWire) {
        let a = PipeWire(), b = PipeWire()
        a.peer = b
        b.peer = a
        return (a, b)
    }

    func send(_ message: WireMessage) async throws {
        guard let peer else { throw AegisError.connection("closed") }
        peer.inboxContinuation.yield(message)
    }

    func receive() async throws -> WireMessage {
        guard let message = try await iterator.next() else { throw AegisError.connection("closed") }
        return message
    }

    func close() {
        inboxContinuation.finish()
        peer?.inboxContinuation.finish()
    }
}
