import Foundation

/// Bitcoin-alphabet base58, as used by libp2p peer ids (no multibase prefix).
enum Base58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
    private static let indexes: [UInt8: Int] = {
        var map: [UInt8: Int] = [:]
        for (i, c) in alphabet.enumerated() { map[c] = i }
        return map
    }()

    static func encode(_ data: Data) -> String {
        let bytes = [UInt8](data)
        let zeros = bytes.prefix { $0 == 0 }.count
        var digits: [UInt8] = []
        for byte in bytes {
            var carry = Int(byte)
            for i in 0..<digits.count {
                carry += Int(digits[i]) << 8
                digits[i] = UInt8(carry % 58)
                carry /= 58
            }
            while carry > 0 {
                digits.append(UInt8(carry % 58))
                carry /= 58
            }
        }
        let leading = [UInt8](repeating: alphabet[0], count: zeros)
        return String(decoding: leading + digits.reversed().map { alphabet[Int($0)] }, as: UTF8.self)
    }

    static func decode(_ string: String) -> Data? {
        let chars = Array(string.utf8)
        let zeros = chars.prefix { $0 == alphabet[0] }.count
        var bytes: [UInt8] = []
        for c in chars {
            guard var carry = indexes[c] else { return nil }
            for i in 0..<bytes.count {
                carry += Int(bytes[i]) * 58
                bytes[i] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 {
                bytes.append(UInt8(carry & 0xff))
                carry >>= 8
            }
        }
        return Data(repeating: 0, count: zeros) + Data(bytes.reversed())
    }
}
