import UserNotifications

/// Replaces "On <Mac>" with the task's title (and project) from the app's cache.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.content = content
        if let sessionId = content.userInfo["sessionId"] as? String,
           let entry = NotificationTitles.load()[sessionId] {
            content.body = entry.title
            if let project = entry.project { content.subtitle = project }
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let content { contentHandler(content) }
    }
}
