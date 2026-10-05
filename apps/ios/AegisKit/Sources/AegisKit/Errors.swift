import Foundation

public enum AegisError: LocalizedError, Equatable {
    case protocolViolation(String)
    case handshake(String)
    case connection(String)
    /// The Mac answered with an error code (UNAUTHORIZED, SESSION_BUSY, …).
    case rejected(String)
    case message(String)

    public var errorDescription: String? {
        switch self {
        case .protocolViolation(let m), .handshake(let m), .connection(let m), .rejected(let m), .message(let m):
            return m
        }
    }
}
