import XCTest
@testable import ProAppStore

@MainActor
final class CatalogueStoreTests: XCTestCase {
    private var directory: URL!
    private var client: PublicFetch!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        client = PublicFetch(configuration: configuration)
        StubProtocol.seen = []
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    private func serve(_ stub: StubProtocol.Stub) { StubProtocol.handler = { _ in stub } }
    private let fresh = StubProtocol.Stub(body: catalogueFixture, headers: ["ETag": "\"v1\""])

    func testCachedCopyIsPublishedBeforeAnyRequest() async throws {
        serve(fresh)
        await CatalogueStore(directory: directory, client: client).refresh()
        StubProtocol.seen = []
        let store = CatalogueStore(directory: directory, client: client)
        XCTAssertEqual(store.catalogue.apps.count, 3)
        XCTAssertTrue(StubProtocol.seen.isEmpty)
    }

    func testRevalidatesWithTheEtagAnd304KeepsTheCache() async throws {
        serve(fresh)
        let store = CatalogueStore(directory: directory, client: client)
        await store.refresh()
        XCTAssertNil(StubProtocol.seen[0].value(forHTTPHeaderField: "If-None-Match"))
        serve(.init(status: 304))
        await store.refresh()
        XCTAssertEqual(StubProtocol.seen[1].value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
        XCTAssertEqual(store.catalogue.apps.count, 3)
        XCTAssertFalse(store.stale)
    }

    func testA200ReplacesAndAMalformed200KeepsTheOldCopy() async throws {
        serve(fresh)
        let store = CatalogueStore(directory: directory, client: client)
        await store.refresh()
        let one = Data(#"{"apps":[{"id":"solo","name":"Solo","appUrl":"https://solo.proappstore.online"}]}"#.utf8)
        serve(.init(body: one, headers: ["ETag": "\"v2\""]))
        await store.refresh()
        XCTAssertEqual(store.catalogue.apps.map(\.id), ["solo"])
        for bad in [StubProtocol.Stub(body: Data("<html>".utf8)), .init(body: Data(#"{"apps":[]}"#.utf8)),
                    .init(status: 500), .init(offline: true),
                    .init(body: Data(#"{"apps":[],"pad":"\#(String(repeating: "x", count: CatalogueStore.maxBytes))"}"#.utf8))] {
            serve(bad)
            await store.refresh()
            XCTAssertEqual(store.catalogue.apps.map(\.id), ["solo"])
            XCTAssertTrue(store.stale)
        }
        XCTAssertEqual(CatalogueStore(directory: directory, client: client).catalogue.apps.map(\.id), ["solo"], "the bad copies were never written")
    }

    func testNoRequestCarriesCredentials() async throws {
        serve(fresh)
        let store = CatalogueStore(directory: directory, client: client)
        await store.refresh(); await store.refresh()
        XCTAssertEqual(StubProtocol.seen.count, 2)
        for request in StubProtocol.seen {
            XCTAssertEqual(request.url, CatalogueStore.url)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        }
    }

    func testARedirectIsNotFollowed() async throws {
        serve(.init(status: 302, redirect: URL(string: "https://attacker.example/catalogue.json")!))
        let store = CatalogueStore(directory: directory, client: client)
        await store.refresh()
        XCTAssertEqual(StubProtocol.seen.map(\.url), [CatalogueStore.url])
        XCTAssertTrue(store.catalogue.apps.isEmpty)
        XCTAssertTrue(store.stale)
    }

    /// Pairing and disconnect run `LocalStore.clear()`, which owns `pas-native/`; the catalogue is elsewhere.
    func testTheCatalogueLivesOutsideTheClearedStore() throws {
        let catalogue = CatalogueStore.defaultDirectory.standardizedFileURL.path
        let native = LocalStore.defaultDirectory.standardizedFileURL.path
        XCTAssertFalse(catalogue.hasPrefix(native + "/") || catalogue == native)
    }
}
