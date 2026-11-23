import Foundation

/// One catalog entry from `GET /native/me`. Same fields as android Models.kt.
struct ConnectedApp: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let purpose: String
    let disclosure: String
    let version: String
    let grantId: String?
    let consentAt: Int64

    init(id: String, name: String, purpose: String, disclosure: String, version: String, grantId: String?, consentAt: Int64 = 0) {
        self.id = id; self.name = name; self.purpose = purpose; self.disclosure = disclosure
        self.version = version; self.grantId = grantId; self.consentAt = consentAt
    }

    private enum Keys: String, CodingKey { case id, name, purpose, disclosure, version, grant }
    private enum GrantKeys: String, CodingKey { case id, consent_at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let grant = try c.decodeNil(forKey: .grant) ? nil : try c.nestedContainer(keyedBy: GrantKeys.self, forKey: .grant)
        self.init(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name),
                  purpose: try c.decode(String.self, forKey: .purpose), disclosure: try c.decode(String.self, forKey: .disclosure),
                  version: try c.decode(String.self, forKey: .version), grantId: try grant?.decode(String.self, forKey: .id),
                  consentAt: try grant?.decode(Int64.self, forKey: .consent_at) ?? 0)
    }
}

/// One queued fix. Encodes to exactly the `POST /native/locations` point shape.
struct TrackPoint: Codable, Equatable {
    let id: String
    let at: Int64
    let lat: Double
    let lng: Double
    let accuracy: Double
    let grants: [String]

    func with(grants: [String]) -> TrackPoint { TrackPoint(id: id, at: at, lat: lat, lng: lng, accuracy: accuracy, grants: grants) }
}

/// A local failure whose text is shown to the user as is.
struct CompanionError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
