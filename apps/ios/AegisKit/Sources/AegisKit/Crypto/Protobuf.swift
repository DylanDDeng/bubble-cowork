import Foundation

/// Just enough protobuf for libp2p keys and the Noise handshake payload.
enum Protobuf {
    enum Field {
        case varint(UInt64)
        case bytes(Data)
    }

    static func varint(_ value: UInt64) -> Data {
        var v = value
        var out = Data()
        repeat {
            var byte = UInt8(v & 0x7f)
            v >>= 7
            if v != 0 { byte |= 0x80 }
            out.append(byte)
        } while v != 0
        return out
    }

    static func bytesField(_ number: UInt64, _ value: Data) -> Data {
        varint(number << 3 | 2) + varint(UInt64(value.count)) + value
    }

    static func varintField(_ number: UInt64, _ value: UInt64) -> Data {
        varint(number << 3) + varint(value)
    }

    /// Decodes a flat message into (field number, value) pairs, in order.
    static func decode(_ data: Data) throws -> [(UInt64, Field)] {
        let bytes = [UInt8](data)
        var i = 0
        func readVarint() throws -> UInt64 {
            var result: UInt64 = 0
            var shift: UInt64 = 0
            while true {
                guard i < bytes.count, shift < 64 else { throw AegisError.protocolViolation("Malformed protobuf") }
                let b = bytes[i]
                i += 1
                result |= UInt64(b & 0x7f) << shift
                if b & 0x80 == 0 { return result }
                shift += 7
            }
        }
        var fields: [(UInt64, Field)] = []
        while i < bytes.count {
            let key = try readVarint()
            switch key & 7 {
            case 0:
                fields.append((key >> 3, .varint(try readVarint())))
            case 2:
                let length = Int(try readVarint())
                guard length >= 0, i + length <= bytes.count else { throw AegisError.protocolViolation("Malformed protobuf") }
                fields.append((key >> 3, .bytes(Data(bytes[i..<(i + length)]))))
                i += length
            default:
                throw AegisError.protocolViolation("Unsupported protobuf wire type")
            }
        }
        return fields
    }
}
