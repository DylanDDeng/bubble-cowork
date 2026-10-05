import AegisKit
import SwiftUI
import UserNotifications

/// APNs registration and notification taps. The Mac sends pushes through the
/// relay only while no phone is connected; they say what happened, never what
/// the agent wrote.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var model: AppModel?
    /// A tapped notification that arrived before the model was ready.
    @MainActor static var pendingSession: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in AppDelegate.model?.setPushToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // In the foreground the session already shows it live.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let sessionId = response.notification.request.content.userInfo["sessionId"] as? String else { return }
        await MainActor.run {
            if let model = AppDelegate.model, model.paired { model.open(session: sessionId) } else { AppDelegate.pendingSession = sessionId }
        }
    }
}

extension AppModel {
    func refreshNotifications() async {
        notificationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if [.authorized, .provisional, .ephemeral].contains(notificationStatus) {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Asked once, after the first task this phone starts, when the reason is obvious.
    func requestNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        await refreshNotifications()
    }

    func setPushToken(_ hex: String) {
        guard client.environment != .fixture, let topic = Bundle.main.bundleIdentifier else { return }
        client.push = PushRegistration(
            deviceToken: hex,
            topic: topic,
            environment: client.environment == .production ? "production" : "development"
        )
    }
}

/// Settings row: what notifications do and how to turn them on.
struct NotificationsSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            switch model.notificationStatus {
            case .authorized, .provisional, .ephemeral:
                LabeledContent("Notifications", value: "On")
            case .denied:
                Button {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                } label: {
                    HStack {
                        Text("Notifications").foregroundStyle(Color.text1)
                        Spacer()
                        Text("Off in Settings").foregroundStyle(Color.text3)
                        Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.text3)
                    }
                }
            default:
                Button("Turn on notifications") { Task { await model.requestNotifications() } }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Get notified when a task needs your approval or finishes while this app is closed. Notifications say what happened, not what the agent wrote.")
        }
    }
}
