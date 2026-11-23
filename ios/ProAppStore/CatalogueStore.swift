import Foundation

/// The credential-free client for the public catalogue and its images (ADR-017 decision 4). It is not `PasApi`,
/// which is the device credential's only gate: no `Authorization`, no cookies, no URL cache, no redirects.
final class PublicFetch: Sendable {
    static let shared = PublicFetch()
    private let session: URLSession

    /// `configuration` exists for tests (a URLProtocol stub).
    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    func get(_ url: URL, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// The catalogue, cached on disk and revalidated with `If-None-Match` when the app becomes active.
/// It lives outside `pas-native/`, so browsing survives `LocalStore.clear()` on pairing and disconnect.
@MainActor
final class CatalogueStore: ObservableObject {
    nonisolated static let url = URL(string: "https://proappstore.online/catalogue.json")!
    nonisolated static let maxBytes = 1_000_000
    nonisolated static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("pas-catalogue", isDirectory: true)
    }

    @Published private(set) var catalogue: Catalogue
    /// The last refresh failed; the cached copy (if any) is shown.
    @Published private(set) var stale = false
    @Published private(set) var loading = false
    private let directory: URL
    private let client: PublicFetch
    private var file: URL { directory.appendingPathComponent("catalogue.json") }
    private var etagFile: URL { directory.appendingPathComponent("catalogue.etag") }

    init(directory: URL = CatalogueStore.defaultDirectory, client: PublicFetch = .shared) {
        self.directory = directory; self.client = client
        catalogue = (try? Data(contentsOf: directory.appendingPathComponent("catalogue.json"))).flatMap(Catalogue.decode) ?? Catalogue(apps: [])
    }

    func refresh() async {
        if loading { return }
        loading = true
        defer { loading = false }
        let etag = catalogue.apps.isEmpty ? nil : try? String(contentsOf: etagFile, encoding: .utf8)
        do {
            let (data, response) = try await client.get(Self.url, headers: etag.map { ["If-None-Match": $0] } ?? [:])
            if response.statusCode == 304 { stale = false; return }
            guard response.statusCode == 200, data.count <= Self.maxBytes, let fresh = Catalogue.decode(data), !fresh.apps.isEmpty else {
                stale = true; return
            }
            try save(data, etag: response.value(forHTTPHeaderField: "ETag"))
            catalogue = fresh; stale = false
        } catch {
            stale = true
        }
    }

    private func save(_ data: Data, etag: String?) throws {
        var dir = directory
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        try data.write(to: file, options: .atomic)
        if let etag { try etag.write(to: etagFile, atomically: true, encoding: .utf8) } else { try? FileManager.default.removeItem(at: etagFile) }
    }
}
