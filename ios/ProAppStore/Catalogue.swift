import Foundation
import SwiftUI

/// One app from the public `https://proappstore.online/catalogue.json` (ADR-017). Decoding validates the entry
/// with the storefront's own rules (`proappstore/build.js`): an invalid entry throws, and `Catalogue` skips it.
struct CatalogueApp: Decodable, Identifiable, Hashable {
    let id: String, name: String, category: String?, icon: String?, iconBg: String?
    let description: String?, about: String?, appUrl: URL, proFeatures: [String]?
    let iconUrl: URL?, heroImageUrl: URL?, websiteUrl: URL?

    private enum Keys: String, CodingKey {
        case id, name, category, icon, iconBg, description, about, appUrl, proFeatures, iconUrl, heroImageUrl, websiteUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func text(_ key: Keys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 } }
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name).trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil, !name.isEmpty,
              let app = text(.appUrl).flatMap(URL.init(string:)), Self.onPlatform(app, apex: false) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "Invalid catalogue entry")
        }
        appUrl = app
        category = text(.category); icon = text(.icon); iconBg = text(.iconBg)
        description = text(.description); about = text(.about)
        proFeatures = (try? c.decodeIfPresent([String].self, forKey: .proFeatures)).flatMap { $0 }?.filter { !$0.isEmpty }
        iconUrl = text(.iconUrl).flatMap(URL.init(string:)).flatMap { Self.onPlatform($0, apex: true) ? $0 : nil }
        heroImageUrl = text(.heroImageUrl).flatMap(URL.init(string:)).flatMap { Self.onPlatform($0, apex: true) ? $0 : nil }
        websiteUrl = text(.websiteUrl).flatMap(URL.init(string:)).flatMap { $0.scheme == "https" && $0.host != nil ? $0 : nil }
    }

    /// `https` on `*.proappstore.online` (and the apex itself when `apex`): `URL_RE` in build.js, and
    /// `isAllowedIconUrl` in storefront.js for images.
    static func onPlatform(_ url: URL, apex: Bool) -> Bool {
        guard url.scheme == "https", url.user == nil, url.port == nil, let host = url.host?.lowercased() else { return false }
        return host.hasSuffix(".proappstore.online") || (apex && host == "proappstore.online")
    }

    /// The emoji drawn on `iconBg`: HTML numeric entities decoded, else the name's first letter.
    var glyph: String {
        let decoded = Self.decodeEntities(icon ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return decoded.isEmpty ? String(name.prefix(1)).uppercased() : decoded
    }

    var tileColor: Color { Color(hex: iconBg) ?? Color(hex: "#7c3aed")! }
    /// Text over `tileColor`: dark on light pastels (`#ecfdf5`), white on the rest.
    var tileIsLight: Bool { Color.luminance(hex: iconBg ?? "#7c3aed") > 0.6 }

    var categoryName: String { Self.displayName(category) }

    static func displayName(_ category: String?) -> String {
        let words = (category ?? "other").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// `&#128222;` and `&#x1F4DE;` to scalars; everything else is kept as is.
    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&#") else { return text }
        var out = "", rest = Substring(text)
        while let start = rest.range(of: "&#") {
            out += rest[..<start.lowerBound]
            let after = rest[start.upperBound...]
            if let end = after.firstIndex(of: ";") {
                let body = after[..<end]
                let value = body.first == "x" || body.first == "X" ? UInt32(body.dropFirst(), radix: 16) : UInt32(body, radix: 10)
                if let value, let scalar = Unicode.Scalar(value) {
                    out.unicodeScalars.append(scalar)
                    rest = after[after.index(after: end)...]
                    continue
                }
            }
            out += "&#"; rest = after
        }
        return out + rest
    }

    func matches(_ query: String) -> Bool {
        let fields = [name, description, categoryName, about].compactMap { $0 } + (proFeatures ?? [])
        return fields.contains { $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}

/// The decoded file. Entries are decoded one by one so a bad entry drops only itself.
struct Catalogue: Decodable {
    let apps: [CatalogueApp]

    private enum Keys: String, CodingKey { case apps }
    private struct Skip: Decodable { init(from decoder: Decoder) {} }

    init(apps: [CatalogueApp]) { self.apps = apps }

    init(from decoder: Decoder) throws {
        var list = try decoder.container(keyedBy: Keys.self).nestedUnkeyedContainer(forKey: .apps)
        var apps: [CatalogueApp] = [], seen = Set<String>()
        while !list.isAtEnd {
            if let app = try? list.decode(CatalogueApp.self) {
                if seen.insert(app.id).inserted { apps.append(app) }
            } else { _ = try list.decode(Skip.self) }
        }
        self.apps = apps
    }

    static func decode(_ data: Data) -> Catalogue? { try? JSONDecoder().decode(Catalogue.self, from: data) }

    /// Up to 5: apps with a hero image, in catalogue order. With fewer than 3 of those, the first other apps fill
    /// the banner as `iconBg` cards. There is no curated `featured` field, so this rule is the curation.
    var featured: [CatalogueApp] {
        let heroes = apps.filter { $0.heroImageUrl != nil }.prefix(5)
        if heroes.count >= 3 { return Array(heroes) }
        return Array(heroes) + apps.filter { $0.heroImageUrl == nil }.prefix(5 - heroes.count)
    }

    /// One row per category, by app count (descending) then name; catalogue order within a row.
    var categories: [(name: String, apps: [CatalogueApp])] {
        Dictionary(grouping: apps, by: \.categoryName)
            .map { (name: $0.key, apps: $0.value) }
            .sorted { $0.apps.count != $1.apps.count ? $0.apps.count > $1.apps.count : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var byName: [CatalogueApp] { apps.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }

    func search(_ query: String) -> [CatalogueApp] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? [] : byName.filter { $0.matches(query) }
    }
}

extension Color {
    /// CSS `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (`COLOR_RE` in build.js). Nil for anything else.
    init?(hex: String?) {
        guard let rgba = Self.components(hex) else { return nil }
        self.init(.sRGB, red: rgba.0, green: rgba.1, blue: rgba.2, opacity: rgba.3)
    }

    static func luminance(hex: String) -> Double {
        guard let (r, g, b, _) = components(hex) else { return 0 }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    private static func components(_ hex: String?) -> (Double, Double, Double, Double)? {
        guard let hex, hex.range(of: "^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", options: .regularExpression) != nil else { return nil }
        var digits = String(hex.dropFirst())
        if digits.count <= 4 { digits = digits.map { "\($0)\($0)" }.joined() }
        if digits.count == 6 { digits += "ff" }
        guard let value = UInt64(digits, radix: 16) else { return nil }
        func byte(_ shift: UInt64) -> Double { Double((value >> shift) & 0xff) / 255 }
        return (byte(24), byte(16), byte(8), byte(0))
    }
}
