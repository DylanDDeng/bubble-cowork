import CryptoKit
import Foundation

/// A libp2p Ed25519 identity, stored exactly like the desktop and the old app:
/// `{ privateKey: base64(PrivateKey protobuf), peerId }`.
public struct Identity: Codable, Equatable, Sendable {
    public let privateKey: String
    public let peerId: String

    public static func create() -> Identity {
        make(Curve25519.Signing.PrivateKey())
    }

    static func make(_ key: Curve25519.Signing.PrivateKey) -> Identity {
        let pub = key.publicKey.rawRepresentation
        // PrivateKey { Type = Ed25519 (1), Data = seed || public key }
        let pb = Protobuf.varintField(1, 1) + Protobuf.bytesField(2, key.rawRepresentation + pub)
        return Identity(privateKey: pb.base64EncodedString(), peerId: PeerID.string(for: pub))
    }

    func signingKey() throws -> Curve25519.Signing.PrivateKey {
        guard let pb = Data(base64Encoded: privateKey) else { throw AegisError.message("Invalid identity") }
        var type: UInt64?
        var data: Data?
        for (number, field) in try Protobuf.decode(pb) {
            if number == 1, case .varint(let v) = field { type = v }
            if number == 2, case .bytes(let b) = field { data = b }
        }
        // 64 bytes (seed || public) today; 96 is libp2p's legacy layout. Both start with the seed.
        guard type == 1, let data, data.count == 64 || data.count == 96 else { throw AegisError.message("Invalid identity") }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data.prefix(32))
    }
}

enum PeerID {
    /// libp2p PublicKey protobuf for Ed25519.
    static func publicKeyProtobuf(_ raw: Data) -> Data {
        Protobuf.varintField(1, 1) + Protobuf.bytesField(2, raw)
    }

    /// Identity multihash of the public key protobuf, base58btc ("12D3KooW…").
    static func string(for raw: Data) -> String {
        let pb = publicKeyProtobuf(raw)
        return Base58.encode(Data([0x00, UInt8(pb.count)]) + pb)
    }

    static func publicKey(fromProtobuf pb: Data) throws -> Data {
        var type: UInt64?
        var data: Data?
        for (number, field) in try Protobuf.decode(pb) {
            if number == 1, case .varint(let v) = field { type = v }
            if number == 2, case .bytes(let b) = field { data = b }
        }
        guard type == 1, let data, data.count == 32 else {
            throw AegisError.handshake("Unsupported identity key")
        }
        return data
    }

    /// Raw Ed25519 public key from a peer id string.
    static func publicKey(from peerId: String) throws -> Data {
        guard let bytes = Base58.decode(peerId), bytes.count == 38, bytes[0] == 0x00, bytes[1] == 36 else {
            throw AegisError.handshake("Invalid peer id")
        }
        return try publicKey(fromProtobuf: bytes.dropFirst(2))
    }
}
