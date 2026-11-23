import SwiftUI
import XCTest
@testable import ProAppStore

/// Three entries copied from the live catalogue.json (2026-11-23, `about` shortened), plus invalid ones.
let catalogueFixture = Data(#"""
{"apps":[
 {"id":"meet","name":"Meet","category":"social","icon":"&#128222;","iconBg":"#ecfdf5","description":"Instant 1-on-1 video meetings with push notifications.","about":"Meet is a zero-install video calling app.\n\nDesigned for quick 1-on-1 calls, not large meetings.","appUrl":"https://meet.proappstore.online","type":"connected","proFeatures":["WebRTC video and audio calls","Availability toggle"],"websiteUrl":"https://about-meet.proappstore.online","iconUrl":"https://meet.proappstore.online/app-icon-512.png","socialImageUrl":"https://meet.proappstore.online/app-icon-512.png","cfProject":"proappstore-meet"},
 {"id":"grasskarma","name":"GrassKarma","category":"marketplace","icon":"🌱","iconBg":"#2D7D7D","description":"Hyper-local lawn care — neighbours share a mower, street by street.","about":"Built on the premise that most suburban streets have 3-4 lawnmowers for 20+ houses.","appUrl":"https://grasskarma.proappstore.online","proFeatures":["Karma tracking for contributions"],"iconUrl":"https://evil.example/icon.png","heroImageUrl":"http://grasskarma.proappstore.online/og.png"},
 {"id":"loopride","name":"Rideshare","category":"transport","icon":"&#128260;","iconBg":"not-a-colour","description":"Recurring rides.","appUrl":"https://rideshare.proappstore.online","iconUrl":"https://rideshare.proappstore.online/icon-512.png","heroImageUrl":"https://proappstore.online/og/rideshare.png"},
 {"id":"Bad Id","name":"Invalid","appUrl":"https://bad.proappstore.online"},
 {"id":"insecure","name":"Insecure","appUrl":"http://insecure.proappstore.online"},
 {"id":"offsite","name":"Offsite","appUrl":"https://evil.example"},
 {"id":"nameless","name":"  ","appUrl":"https://nameless.proappstore.online"},
 "not an object"
]}
"""#.utf8)

final class CatalogueTests: XCTestCase {
    private func fixture() throws -> Catalogue { try XCTUnwrap(Catalogue.decode(catalogueFixture)) }

    /// A minimal valid entry, for the selection rules.
    private func app(_ id: String, category: String = "productivity", hero: Bool = false, about: String? = nil) throws -> CatalogueApp {
        var entry: [String: Any] = ["id": id, "name": id.capitalized, "category": category, "appUrl": "https://\(id).proappstore.online"]
        if hero { entry["heroImageUrl"] = "https://\(id).proappstore.online/og-image.png" }
        if let about { entry["about"] = about }
        return try JSONDecoder().decode(CatalogueApp.self, from: JSONSerialization.data(withJSONObject: entry))
    }

    func testInvalidEntriesAreSkippedNotFatal() throws {
        XCTAssertEqual(try fixture().apps.map(\.id), ["meet", "grasskarma", "loopride"])
    }

    func testEmojiFromEntitiesRawEmojiOrInitial() throws {
        let apps = try fixture().apps
        XCTAssertEqual(apps[0].glyph, "📞")
        XCTAssertEqual(apps[1].glyph, "🌱")
        XCTAssertEqual(CatalogueApp.decodeEntities("&#10084;"), "❤")
        XCTAssertEqual(CatalogueApp.decodeEntities("&#x1F4DE;"), "📞")
        XCTAssertEqual(CatalogueApp.decodeEntities("a &#bad; b"), "a &#bad; b")
        XCTAssertEqual(try app("planner").glyph, "P") // no icon
    }

    func testImageUrlsOnlyFromThePlatform() throws {
        let apps = try fixture().apps
        XCTAssertEqual(apps[0].iconUrl?.absoluteString, "https://meet.proappstore.online/app-icon-512.png")
        XCTAssertNil(apps[1].iconUrl, "off-origin")
        XCTAssertNil(apps[1].heroImageUrl, "http")
        XCTAssertEqual(apps[2].heroImageUrl?.host, "proappstore.online", "the apex is allowed for images")
        XCTAssertNil(apps[0].heroImageUrl, "socialImageUrl is never used")
    }

    func testColourFallsBackToTheDefault() throws {
        let apps = try fixture().apps
        XCTAssertNotNil(Color(hex: "#2D7D7D")); XCTAssertNotNil(Color(hex: "#abc")); XCTAssertNotNil(Color(hex: "#7c3aedcc"))
        XCTAssertNil(Color(hex: "not-a-colour")); XCTAssertNil(Color(hex: "#12345"))
        XCTAssertEqual(apps[2].tileColor, Color(hex: "#7c3aed"))
        XCTAssertTrue(apps[0].tileIsLight); XCTAssertFalse(apps[1].tileIsLight)
    }

    func testCategoryDisplayName() {
        XCTAssertEqual(CatalogueApp.displayName("real-estate"), "Real estate")
        XCTAssertEqual(CatalogueApp.displayName("productivity"), "Productivity")
        XCTAssertEqual(CatalogueApp.displayName(nil), "Other")
    }

    func testCategoriesByCountThenName() throws {
        let catalogue = Catalogue(apps: [try app("a", category: "travel"), try app("b", category: "sports"), try app("c", category: "business"),
                                         try app("d", category: "sports"), try app("e", category: "business"), try app("f", category: "sports")])
        XCTAssertEqual(catalogue.categories.map(\.name), ["Sports", "Business", "Travel"])
        XCTAssertEqual(catalogue.categories[0].apps.map(\.id), ["b", "d", "f"], "catalogue order within a row")
    }

    func testSearchCoversAboutAndFeaturesInsensitively() throws {
        let catalogue = try fixture()
        XCTAssertEqual(catalogue.search("lawnmowers").map(\.id), ["grasskarma"], "a word only in about")
        XCTAssertEqual(catalogue.search("  webrtc ").map(\.id), ["meet"], "pro features, case-insensitive")
        XCTAssertEqual(try Catalogue(apps: [app("cafe", about: "Order at the café")]).search("CAFE").map(\.id), ["cafe"], "diacritics")
        XCTAssertEqual(catalogue.search("marketplace").map(\.id), ["grasskarma"], "category")
        XCTAssertEqual(catalogue.search("zzz"), [])
        XCTAssertEqual(catalogue.search(" "), [])
    }

    func testFeaturedWithNoHeroImages() throws {
        let catalogue = Catalogue(apps: try (1...7).map { try app("app\($0)") })
        XCTAssertEqual(catalogue.featured.map(\.id), ["app1", "app2", "app3", "app4", "app5"])
    }

    func testFeaturedWithFourHeroImages() throws {
        let apps = try [app("a"), app("b", hero: true), app("c", hero: true), app("d"), app("e", hero: true), app("f", hero: true)]
        XCTAssertEqual(Catalogue(apps: apps).featured.map(\.id), ["b", "c", "e", "f"])
        // Fewer than three: the first other apps fill the banner.
        XCTAssertEqual(try Catalogue(apps: [app("a"), app("b", hero: true), app("c")]).featured.map(\.id), ["b", "a", "c"])
    }
}
