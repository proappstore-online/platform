import Foundation

/// Plain sentences and symbols for the activity log. Pure.
enum ActivityText {
    enum Category { case sharing, problem }

    static func category(_ kind: ShareEvent.Kind) -> Category {
        switch kind {
        case .enabled, .disabled, .paused, .resumed, .pausedAll, .resumedAll, .grantLost, .grantRestored, .historyCleared, .heartRate: .sharing
        case .stopped, .syncFailed, .syncRecovered, .uploadRejected, .quota, .permission, .queueFull, .expired, .heartRateProblem, .bluetooth: .problem
        }
    }

    /// `appName` is the app's display name, or nil for device-wide events.
    static func sentence(for event: ShareEvent, appName: String?) -> String {
        let app = appName ?? event.appId ?? "App"
        switch event.kind {
        case .enabled: return "\(app) sharing turned on"
        case .disabled: return "\(app) sharing turned off"
        case .paused: return "\(app) paused by you"
        case .resumed: return "\(app) resumed by you"
        case .pausedAll: return "All sharing paused by you"
        case .resumedAll: return "All sharing resumed"
        case .stopped:
            let reason = ["signed_out": "this phone was signed out", "storage_failed": "location could not be saved on this phone",
                          "unlock_failed": "the device connection could not be unlocked"][event.detail] ?? event.detail
            return "Sharing stopped: \(reason)"
        case .grantLost:
            return event.detail == "replaced"
                ? "\(app) access replaced by ProAppStore (the app changed owner or its disclosure)"
                : "\(app) access revoked by ProAppStore (the app changed owner or its disclosure)"
        case .grantRestored: return "\(app) access restored"
        case .historyCleared: return "History cleared"
        case .syncFailed:
            // detail = "<status> <server error text>", status 0 = network; or a local failure's text.
            let parts = event.detail.split(separator: " ", maxSplits: 1).map(String.init)
            guard let status = parts.first.flatMap({ Int($0) }) else { return "Upload failed: \(event.detail)" }
            if status == 0 { return "Upload failed (offline)" }
            return "Upload failed: \(parts.count > 1 ? parts[1] : "error") (\(status))"
        case .syncRecovered: return "Uploads working again \(event.detail)".trimmingCharacters(in: .whitespaces)
        case .uploadRejected:
            return event.detail == "partial_ack"
                ? "Upload not fully acknowledged: the copy on this phone was kept"
                : "Upload rejected by ProAppStore (\(event.detail))"
        case .quota: return "Upload limit reached (429)"
        case .permission:
            switch event.detail {
            case "precise→approximate": return "Precise Location turned off: recording stopped"
            case "approximate→precise": return "Precise Location turned on"
            default:
                let names = ["notDetermined": "Not set", "whenInUse": "While Using", "always": "Always", "denied": "Denied", "restricted": "Restricted"]
                let sides = event.detail.components(separatedBy: "→").map { names[$0] ?? $0 }
                return "Location permission changed: \(sides.joined(separator: " → "))"
            }
        case .queueFull: return "Storage queue full: recording stopped until uploads catch up"
        case .expired:
            return event.detail == "renew"
                ? "Reconnecting to ProAppStore: sharing stopped until you re-enable apps"
                : "Connection to ProAppStore expired: sharing stopped"
        case .heartRate:
            switch event.detail {
            case "enabled": return "\(app) heart rate turned on"
            case "disabled": return "\(app) heart rate turned off"
            case "sensor_chosen": return "Heart-rate sensor chosen"
            case "connected": return "Heart-rate sensor connected"
            case "lost": return "Heart-rate sensor disconnected or out of range"
            case "forgotten": return "Heart-rate sensor forgotten"
            default: return "Heart rate: \(event.detail)"
            }
        case .heartRateProblem:
            switch event.detail {
            case "queue_full": return "Heart-rate queue full: heart rate stopped until uploads catch up"
            case "partial_ack": return "Heart-rate upload not fully acknowledged: the copy on this phone was kept"
            default: return "Heart-rate upload rejected by ProAppStore (\(event.detail))"
            }
        case .bluetooth:
            switch event.detail {
            case "off": return "Bluetooth turned off: heart rate stopped"
            case "on": return "Bluetooth turned on"
            case "unauthorized": return "Bluetooth permission denied: heart rate stopped"
            case "unsupported": return "Bluetooth is not available on this phone"
            default: return "Bluetooth: \(event.detail)"
            }
        }
    }

    static func symbol(_ kind: ShareEvent.Kind) -> String {
        switch kind {
        case .enabled: "location.circle"
        case .disabled: "location.slash"
        case .paused, .pausedAll: "pause.circle"
        case .resumed, .resumedAll: "play.circle"
        case .stopped: "stop.circle"
        case .grantLost: "xmark.shield"
        case .grantRestored: "checkmark.shield"
        case .historyCleared: "trash"
        case .syncFailed: "exclamationmark.icloud"
        case .syncRecovered: "checkmark.icloud"
        case .uploadRejected: "xmark.icloud"
        case .quota: "gauge.with.dots.needle.100percent"
        case .permission: "lock.shield"
        case .queueFull: "externaldrive.badge.exclamationmark"
        case .expired: "link.badge.plus"
        case .heartRate: "heart"
        case .heartRateProblem: "heart.slash"
        case .bluetooth: "antenna.radiowaves.left.and.right.slash"
        }
    }
}
