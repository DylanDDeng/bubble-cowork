import Foundation

/// Session titles for notifications, shared with the notification extension through
/// the App Group. Pushes carry only a session id, so the relay and APNs never see a
/// title; the phone fills it in from what it already shows in the sidebar.
enum NotificationTitles {
    struct Entry: Codable, Equatable {
        let title: String
        let project: String?
    }

    /// `group.<app bundle id>`; the extension's id is the app's plus ".notifications".
    static var groupId: String {
        var id = Bundle.main.bundleIdentifier ?? "ai.aegis.companion"
        if id.hasSuffix(".notifications") { id.removeLast(".notifications".count) }
        return "group." + id
    }

    private static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)?
            .appendingPathComponent("notification-titles.json")
    }

    static func load() -> [String: Entry] {
        guard let file, let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    /// Readable after first unlock: pushes arrive while the phone is locked.
    static func save(_ entries: [String: Entry]) {
        guard let file, let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
