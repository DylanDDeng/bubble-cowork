import CryptoKit
import Foundation

// Noise_XX_25519_ChaChaPoly_SHA256 with the libp2p handshake payload, matching
// @chainsafe/libp2p-noise 16 as used by src/shared/remote/secure-channel.ts.

let noiseProtocolName = Data("Noise_XX_25519_ChaChaPoly_SHA256".utf8)
let aegisPrologue = Data("aegis.remote.v1/noise-xx/1".utf8)
private let signaturePrefix = Data("noise-libp2p-static-key:".utf8)
private let maxNonce: UInt64 = 0xffff_ffff

struct CipherState {
    var key: SymmetricKey?
    var nonce: UInt64 = 0

    private func nonceBytes() throws -> ChaChaPoly.Nonce {
        guard nonce <= maxNonce else { throw AegisError.connection("Cipher state exhausted") }
        var bytes = Data(repeating: 0, count: 4)
        withUnsafeBytes(of: nonce.littleEndian) { bytes.append(contentsOf: $0) }
        return try ChaChaPoly.Nonce(data: bytes)
    }

    mutating func encrypt(_ plaintext: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return plaintext }
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: try nonceBytes(), authenticating: ad)
        nonce += 1
        return box.ciphertext + box.tag
    }

    mutating func decrypt(_ ciphertext: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return ciphertext }
        guard ciphertext.count >= 16 else { throw AegisError.handshake("Ciphertext too short") }
        let box = try ChaChaPoly.SealedBox(
            nonce: try nonceBytes(),
            ciphertext: ciphertext.prefix(ciphertext.count - 16),
            tag: ciphertext.suffix(16)
        )
        let plaintext: Data
        do { plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad) } catch {
            throw AegisError.handshake("Decryption failed")
        }
        nonce += 1
        return plaintext
    }
}

/// HKDF-SHA256 with the chaining key as salt and empty info, two 32-byte outputs.
func noiseHKDF(chainingKey: Data, input: Data) -> (Data, Data) {
    let prk = Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: chainingKey)))
    let key = SymmetricKey(data: prk)
    let out1 = Data(HMAC<SHA256>.authenticationCode(for: Data([0x01]), using: key))
    let out2 = Data(HMAC<SHA256>.authenticationCode(for: out1 + Data([0x02]), using: key))
    return (out1, out2)
}

struct SymmetricState {
    var ck: Data
    var h: Data
    var cipher = CipherState()

    init() {
        // The protocol name is exactly 32 bytes, so it is used as-is.
        h = noiseProtocolName
        ck = noiseProtocolName
    }

    mutating func mixHash(_ data: Data) {
        h = Data(SHA256.hash(data: h + data))
    }

    mutating func mixKey(_ input: Data) {
        let (ck, k) = noiseHKDF(chainingKey: ck, input: input)
        self.ck = ck
        cipher = CipherState(key: SymmetricKey(data: k), nonce: 0)
    }

    mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(plaintext, ad: h)
        mixHash(ciphertext)
        return ciphertext
    }

    mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ciphertext, ad: h)
        mixHash(ciphertext)
        return plaintext
    }

    func split() -> (CipherState, CipherState) {
        let (k1, k2) = noiseHKDF(chainingKey: ck, input: Data())
        return (CipherState(key: SymmetricKey(data: k1)), CipherState(key: SymmetricKey(data: k2)))
    }
}

private func dh(_ priv: Curve25519.KeyAgreement.PrivateKey, _ pub: Data) throws -> Data {
    do {
        let secret = try priv.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub))
        return secret.withUnsafeBytes { Data($0) }
    } catch {
        throw AegisError.handshake("Invalid key agreement")
    }
}

/// libp2p handshake payload: identity key, signature over the Noise static key,
/// and empty extensions (no stream muxers, no certhashes).
func makePayload(identity: Curve25519.Signing.PrivateKey, staticKey: Data) throws -> Data {
    let signature = try identity.signature(for: signaturePrefix + staticKey)
    return Protobuf.bytesField(1, PeerID.publicKeyProtobuf(identity.publicKey.rawRepresentation))
        + Protobuf.bytesField(2, signature)
        + Protobuf.bytesField(4, Data())
}

/// Verifies a remote payload and returns the remote Ed25519 public key.
func verifyPayload(_ payload: Data, remoteStatic: Data, expected: Data?) throws -> Data {
    var identityKey: Data?
    var signature: Data?
    for (number, field) in try Protobuf.decode(payload) {
        guard case .bytes(let value) = field else { continue }
        switch number {
        case 1: identityKey = value
        case 2: signature = value
        case 4:
            // stream_muxers (2) must be empty: this side offers no muxers.
            for (ext, _) in try Protobuf.decode(value) where ext == 2 {
                throw AegisError.handshake("No common stream muxers")
            }
        default: break
        }
    }
    guard let identityKey, let signature else { throw AegisError.handshake("Missing identity in handshake") }
    let raw = try PeerID.publicKey(fromProtobuf: identityKey)
    if let expected, expected != raw { throw AegisError.handshake("Unexpected desktop identity") }
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
    guard key.isValidSignature(signature, for: signaturePrefix + remoteStatic) else {
        throw AegisError.handshake("Invalid handshake signature")
    }
    return raw
}

/// XX handshake state for one side. Messages are the Noise bodies without the
/// u16 length prefix.
struct NoiseHandshake {
    let initiator: Bool
    private var state = SymmetricState()
    private let identity: Curve25519.Signing.PrivateKey
    private let staticKey = Curve25519.KeyAgreement.PrivateKey()
    private let ephemeral = Curve25519.KeyAgreement.PrivateKey()
    private var remoteEphemeral = Data()
    private var remoteStatic = Data()
    private let expectedRemote: Data?
    private(set) var remoteIdentity: Data?

    init(initiator: Bool, identity: Curve25519.Signing.PrivateKey, expectedRemote: Data? = nil) {
        self.initiator = initiator
        self.identity = identity
        self.expectedRemote = expectedRemote
        state.mixHash(aegisPrologue)
    }

    private var staticPublic: Data { staticKey.publicKey.rawRepresentation }

    // Initiator → responder: e
    mutating func writeA() throws -> Data {
        let e = ephemeral.publicKey.rawRepresentation
        state.mixHash(e)
        return e + (try state.encryptAndHash(Data()))
    }

    mutating func readA(_ message: Data) throws {
        guard message.count >= 32 else { throw AegisError.handshake("Short handshake message") }
        remoteEphemeral = message.prefix(32)
        state.mixHash(remoteEphemeral)
        _ = try state.decryptAndHash(message.dropFirst(32))
    }

    // Responder → initiator: e, ee, s, es, payload
    mutating func writeB() throws -> Data {
        let e = ephemeral.publicKey.rawRepresentation
        state.mixHash(e)
        state.mixKey(try dh(ephemeral, remoteEphemeral))
        let s = try state.encryptAndHash(staticPublic)
        state.mixKey(try dh(staticKey, remoteEphemeral))
        let payload = try state.encryptAndHash(try makePayload(identity: identity, staticKey: staticPublic))
        return e + s + payload
    }

    mutating func readB(_ message: Data) throws {
        guard message.count >= 32 + 48 + 16 else { throw AegisError.handshake("Short handshake message") }
        let bytes = Data(message)
        remoteEphemeral = bytes.prefix(32)
        state.mixHash(remoteEphemeral)
        state.mixKey(try dh(ephemeral, remoteEphemeral))
        remoteStatic = try state.decryptAndHash(bytes.subdata(in: 32..<80))
        state.mixKey(try dh(ephemeral, remoteStatic))
        let payload = try state.decryptAndHash(bytes.subdata(in: 80..<bytes.count))
        remoteIdentity = try verifyPayload(payload, remoteStatic: remoteStatic, expected: expectedRemote)
    }

    // Initiator → responder: s, se, payload
    mutating func writeC() throws -> Data {
        let s = try state.encryptAndHash(staticPublic)
        state.mixKey(try dh(staticKey, remoteEphemeral))
        let payload = try state.encryptAndHash(try makePayload(identity: identity, staticKey: staticPublic))
        return s + payload
    }

    mutating func readC(_ message: Data) throws {
        guard message.count >= 48 + 16 else { throw AegisError.handshake("Short handshake message") }
        let bytes = Data(message)
        remoteStatic = try state.decryptAndHash(bytes.prefix(48))
        state.mixKey(try dh(ephemeral, remoteStatic))
        let payload = try state.decryptAndHash(bytes.subdata(in: 48..<bytes.count))
        remoteIdentity = try verifyPayload(payload, remoteStatic: remoteStatic, expected: expectedRemote)
    }

    /// (send, receive) cipher states.
    func split() -> (CipherState, CipherState) {
        let (c1, c2) = state.split()
        return initiator ? (c1, c2) : (c2, c1)
    }
}
