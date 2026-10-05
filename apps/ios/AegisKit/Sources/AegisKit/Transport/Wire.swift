import Foundation

public enum WireMessage: Sendable {
    case text(String)
    case binary(Data)
}

/// A message-oriented connection: the relay WebSocket in the app, a pipe in tests.
public protocol WireConnection: AnyObject, Sendable {
    func send(_ message: WireMessage) async throws
    func receive() async throws -> WireMessage
    func close()
}

/// The relay WebSocket. One Noise message is sent per binary frame.
public final class RelaySocket: NSObject, WireConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    private let opened = OpenSignal()

    public init(url: URL) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let delegateProxy = DelegateProxy()
        session = URLSession(configuration: config, delegate: delegateProxy, delegateQueue: queue)
        task = session.webSocketTask(with: url)
        // The relay allows 256 KiB; Noise messages are at most 64 KiB.
        task.maximumMessageSize = 1 << 20
        super.init()
        delegateProxy.owner = self
        task.resume()
    }

    /// Waits until the WebSocket handshake finished (or failed).
    public func waitOpen(timeout: TimeInterval = 15) async throws {
        try await opened.wait(timeout: timeout)
    }

    public func send(_ message: WireMessage) async throws {
        switch message {
        case .text(let text): try await task.send(.string(text))
        case .binary(let data): try await task.send(.data(data))
        }
    }

    public func receive() async throws -> WireMessage {
        switch try await task.receive() {
        case .string(let text): return .text(text)
        case .data(let data): return .binary(data)
        @unknown default: throw AegisError.connection("Unsupported frame")
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        opened.fail(AegisError.connection("Connection closed"))
    }

    fileprivate func didOpen() { opened.succeed() }
    fileprivate func didFail(_ error: Error?) {
        opened.fail(error ?? AegisError.connection("Connection closed"))
    }

    /// Breaks the URLSession → delegate retain cycle.
    private final class DelegateProxy: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
        weak var owner: RelaySocket?
        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            owner?.didOpen()
        }
        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            owner?.didFail(nil)
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            owner?.didFail(error)
        }
    }
}

/// One-shot signal that can be awaited with a timeout.
final class OpenSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    private var waiters: [CheckedContinuation<Void, Error>] = []

    func succeed() { resolve(.success(())) }
    func fail(_ error: Error) { resolve(.failure(error)) }

    private func resolve(_ value: Result<Void, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.resume(with: value) }
    }

    func wait(timeout: TimeInterval) async throws {
        let timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(timeout))
            self?.fail(AegisError.connection("Connection timed out"))
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }
}
