import CoreBluetooth
import CoreLocation
import CryptoKit
import Foundation
import UIKit
import UserNotifications

/// The phone's state that lives on the main actor (#660): permissions in the snapshot's vocabulary and the collectors'
/// state. `CompanionModel.diagnosticsDevice()` reads it.
struct DiagnosticsDevice: Equatable {
    var os: String
    var location: String
    var precise: Bool
    var bluetooth: String
    var notifications: String
    var collecting: Bool
    var heartRateConnected: Bool
}

/// One `share_events` row with its raw kind, so kinds this build does not know are still reported.
struct ActivityRow: Equatable {
    let at: Int64
    let appId: String?
    let kind: String
    let detail: String
}

/// Everything the snapshot is built from. Counts and states only: no queue payloads, points or heart-rate samples.
struct DiagnosticsInput {
    var now: Int64
    var version: String
    var build: String
    var device: DiagnosticsDevice
    var entries: [NativeEntry]
    var blocked: Set<String>
    var expired: Bool
    var sessions: [Session]
    var heartRateSensor: Bool
    var queue: Int
    var heartRateQueue: Int
    var lastSync: Int64
    var lastSyncAttempt: Int64
    var lastSyncError: String
    var heartRateLastUpload: Int64
    var heartRateSyncError: String
    /// Every `session_ended` row; the builder keeps each app's latest.
    var sessionEnds: [ActivityRow]
    /// The last 7 days of `share_events`, newest first, at most `Diagnostics.MAX_EVENTS`.
    var activity: [ActivityRow]
}

/// Phone diagnostics (#660, ADR-019): a whitelisted snapshot of the companion's state, sent at the end of a sync. It never
/// contains a location, a heart-rate reading or a sensor identifier. Pure, so the rules are unit-tested. Ported from
/// android Diagnostics.kt.
enum Diagnostics {
    static let PATH = "/native/diagnostics"
    static let MAX_EVENTS = 200
    static let WINDOW_MS: Int64 = 7 * 24 * 60 * 60 * 1000
    /// Under the server's 64 KB body cap with room for the `{"snapshot":…}` wrapper.
    static let MAX_BYTES = 60_000
    static let REFRESH_MS: Int64 = 15 * 60 * 1000
    static let CHANGE_MS: Int64 = 60_000
    private static let MAX_LIST = 50

    /// Reads the system and collector state the snapshot reports. Asks for nothing: no permission prompt.
    @MainActor static func device(_ collector: LocationCollector, _ heartRate: HeartRateCollector) async -> DiagnosticsDevice {
        let notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return DiagnosticsDevice(os: "iOS \(UIDevice.current.systemVersion)", location: location(collector.authorization),
                                 precise: collector.fullAccuracy, bluetooth: bluetooth(CBManager.authorization, heartRate.bluetooth),
                                 notifications: Self.notifications(notifications), collecting: collector.running,
                                 heartRateConnected: heartRate.connected)
    }

    // MARK: Vocabulary

    /// Restricted is reported as denied; precise is its own field.
    static func location(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedWhenInUse: "whenInUse"
        case .authorizedAlways: "always"
        case .denied, .restricted: "denied"
        default: "notDetermined"
        }
    }

    /// Permission first; once allowed, the radio's state.
    static func bluetooth(_ authorization: CBManagerAuthorization, _ state: CBManagerState) -> String {
        switch authorization {
        case .notDetermined: return "notDetermined"
        case .denied, .restricted: return "denied"
        default:
            switch state {
            case .poweredOff: return "off"
            case .unsupported: return "unsupported"
            default: return "allowed"
            }
        }
    }

    /// Provisional (the session-end notices, #687) counts as allowed.
    static func notifications(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: "notDetermined"
        case .denied: "denied"
        default: "allowed"
        }
    }

    /// The heart-rate collector's state as one code, in the Heart rate line's order (HeartRateViews.swift `state`), which
    /// checks the full queue before Bluetooth; Android checks Bluetooth first.
    static func heartRateState(entries: [NativeEntry], blocked: Set<String>, expired: Bool, sessions: Set<String>,
                               sensor: Bool, bluetooth: String, queued: Int, connected: Bool) -> String {
        let enabled = entries.filter { $0.capability == HeartRate.CAPABILITY && $0.grantId != nil && !blocked.contains($0.key) && !expired }
        if enabled.isEmpty { return "off" }
        if !enabled.contains(where: { sessions.contains($0.appId) }) { return "no_session" }
        if !sensor { return "no_sensor" }
        if queued >= HeartRatePolicy.MAX_QUEUE { return "queue_full" }
        if bluetooth == "off" { return "bluetooth_off" }
        if bluetooth == "denied" { return "bluetooth_denied" }
        return connected ? "connected" : "not_connected"
    }

    /// Each app's latest `session_ended`, newest first, skipping a reason the server would reject.
    static func lastEnded(_ rows: [ActivityRow]) -> [ActivityRow] {
        var latest: [String: ActivityRow] = [:]
        for row in rows where matches(row.detail, code) {
            guard let appId = row.appId else { continue }
            if latest[appId].map({ row.at > $0.at }) ?? true { latest[appId] = row }
        }
        return Array(latest.values.sorted { $0.at > $1.at }.prefix(MAX_LIST))
    }

    // MARK: Snapshot

    static func build(_ input: DiagnosticsInput) -> [String: Any] {
        let d = input.device
        let sessionIds = Set(input.sessions.map(\.appId))
        var snapshot: [String: Any] = [
            "v": 1, "at": input.now,
            "app": ["platform": "ios", "version": input.version, "build": input.build, "os": String(d.os.prefix(40))],
            "permissions": ["location": d.location, "precise": d.precise, "bluetooth": d.bluetooth, "notifications": d.notifications],
            "sensors": [
                "location": d.collecting ? "collecting" : input.sessions.isEmpty ? "idle" : "stopped",
                "heartRate": heartRateState(entries: input.entries, blocked: input.blocked, expired: input.expired, sessions: sessionIds,
                                            sensor: input.heartRateSensor, bluetooth: d.bluetooth, queued: input.heartRateQueue,
                                            connected: d.heartRateConnected),
            ],
            "queue": ["location": input.queue, "heartRate": input.heartRateQueue],
            "sync": [
                "lastSuccessAt": orNull(input.lastSync), "lastAttemptAt": orNull(input.lastSyncAttempt),
                "lastError": String(input.lastSyncError.prefix(120)),
                "heartRate": ["lastUploadAt": orNull(input.heartRateLastUpload), "lastError": String(input.heartRateSyncError.prefix(120))],
            ],
            "collection": [
                "sessions": input.sessions.prefix(MAX_LIST).map { ["appId": $0.appId, "startedAt": $0.startedAt, "lastMovedAt": $0.lastMovedAt] },
                "lastEnded": lastEnded(input.sessionEnds).map { ["appId": $0.appId ?? "", "at": $0.at, "reason": $0.detail] },
                "pendingRevocations": Array(input.blocked.sorted().prefix(MAX_LIST)),
            ],
            "activity": [Any](),
        ]
        // Capped by bytes (#660 comment 3): newest first, so the oldest events are the ones dropped.
        var activity: [Any] = []
        var bytes = encode(snapshot).count
        for row in input.activity.filter({ $0.at >= input.now - WINDOW_MS && matches($0.kind, kind) }).prefix(MAX_EVENTS) {
            let event: [String: Any] = ["at": row.at, "appId": row.appId ?? NSNull(), "kind": row.kind, "detail": String(row.detail.prefix(120))]
            let size = encode(event).count + (activity.isEmpty ? 0 : 1)
            if bytes + size > MAX_BYTES { break }
            activity.append(event); bytes += size
        }
        snapshot["activity"] = activity
        return snapshot
    }

    /// The exact bytes sent and stored: sorted keys, so the same state always encodes the same way.
    static func encode(_ value: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    /// The snapshot without what changes on every sync: `at`, `queue`, and the sync times. Changing it allows a send after 60 s.
    static func fingerprint(_ snapshot: [String: Any]) -> String {
        var copy = snapshot
        copy["at"] = nil; copy["queue"] = nil
        if var sync = copy["sync"] as? [String: Any] {
            sync["lastAttemptAt"] = nil; sync["lastSuccessAt"] = nil
            if var heartRate = sync["heartRate"] as? [String: Any] { heartRate["lastUploadAt"] = nil; sync["heartRate"] = heartRate }
            copy["sync"] = sync
        }
        return SHA256.hash(data: encode(copy)).map { String(format: "%02x", $0) }.joined()
    }

    /// Never sent, 15 minutes since the last send, or a changed fingerprint 60 s after it.
    static func due(sentAt: Int64, lastFingerprint: String, fingerprint: String, now: Int64) -> Bool {
        sentAt == 0 || now - sentAt >= REFRESH_MS || (fingerprint != lastFingerprint && now - sentAt >= CHANGE_MS)
    }

    private static let code = try! NSRegularExpression(pattern: "^[a-z_]{1,24}$")
    private static let kind = try! NSRegularExpression(pattern: "^[a-z_]{1,32}$")
    private static func matches(_ value: String, _ pattern: NSRegularExpression) -> Bool {
        pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
    private static func orNull(_ value: Int64) -> Any { value > 0 ? value : NSNull() }
}
