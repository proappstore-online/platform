import Foundation

struct ApiFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// Only the platform origin receives the narrow native credential; redirects are refused. Ported from PasApi.kt.
final class PasApi: Sendable {
    static let ORIGIN = "https://api.proappstore.online"
    private let session: URLSession

    /// `configuration` exists for tests (a URLProtocol stub); the origin is fixed.
    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    /// Sent on every request (#660): the server records the app version and last sync for the user's device list.
    static let client = "ios/\(AppInfo.current.version) (\(AppInfo.current.build))"

    /// The only URLs a request may target: `/v1/native/*` on the fixed origin. Nil for any other path.
    static func endpoint(_ path: String) -> URL? {
        path.hasPrefix("/native/") ? URL(string: "\(ORIGIN)/v1\(path)") : nil
    }

    func request(_ method: String, _ path: String, token: String? = nil, body: Data? = nil) async throws -> [String: Any] {
        guard let url = Self.endpoint(path) else { preconditionFailure("Native requests are limited to /native/") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Self.client, forHTTPHeaderField: "X-PAS-Native-Client")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200...299).contains(code) else {
            throw ApiFailure(status: code, message: result["error"] as? String ?? "Could not reach ProAppStore (\(code)).")
        }
        return result
    }
}

/// Refuses every redirect, so a session only ever talks to the URL it was given: PasApi's origin, PublicFetch's files.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
