import SwiftUI

// Design tokens from the approved design canvas:
// neutral ink palette, one indigo accent, iOS 26 Liquid Glass surfaces.
extension Color {
    private static func dynamic(_ light: UInt32, _ dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        func ui(_ hex: UInt32, _ alpha: Double) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                    blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark, darkAlpha) : ui(light, lightAlpha) })
    }

    static let accent = dynamic(0x4f46e5, 0x818cf8)
    static let page = dynamic(0xffffff, 0x0e0e0f)
    static let fill2 = dynamic(0xf2f2f3, 0x1f1f21)
    static let fill3 = dynamic(0xe5e5e8, 0x2e2e31)
    static let grouped = dynamic(0xf2f2f7, 0x000000)
    static let cell = dynamic(0xffffff, 0x1c1c1e)
    static let text1 = dynamic(0x0d0d0d, 0xf4f4f5)
    static let text2 = dynamic(0x5c5c62, 0xa6a6ad)
    static let text3 = dynamic(0x6e6e74, 0x8e8e95)
    static let hair = dynamic(0x000000, 0xffffff, lightAlpha: 0.08, darkAlpha: 0.09)
    static let ink = dynamic(0x0d0d0d, 0xf4f4f5)
    static let onInk = dynamic(0xffffff, 0x0d0d0d)
    static let inkOff = dynamic(0xd4d4d8, 0x3a3a3e)
    static let code = dynamic(0xf6f6f7, 0x18181a)
    static let warn = dynamic(0xa84a06, 0xf5a524)
    static let warnBg = dynamic(0xf59e0b, 0xf59e0b, lightAlpha: 0.13, darkAlpha: 0.15)
    static let danger = dynamic(0xc4271c, 0xff6b5e)
    static let dangerBg = dynamic(0xdc2626, 0xff5046, lightAlpha: 0.07, darkAlpha: 0.12)
    static let success = dynamic(0x13784a, 0x4ade80)
    static let online = dynamic(0x22c55e, 0x22c55e)
    static let addBg = dynamic(0x22a05a, 0x2ea043, lightAlpha: 0.12, darkAlpha: 0.2)
    static let delBg = dynamic(0xdc3232, 0xf85149, lightAlpha: 0.1, darkAlpha: 0.18)
    static let add = dynamic(0x0f6b3a, 0x7ce7a8)
    static let del = dynamic(0xae2129, 0xff9088)
}

extension Font {
    static let mono = Font.system(size: 13, design: .monospaced)
}

/// Provider marks, same artwork as the desktop ProviderIcon (template SVGs in the asset catalog).
let providerLabels: [String: String] = [
    "claude": "Claude", "codex": "Codex", "bubble": "Bubble", "kimi": "Kimi", "grok": "Grok",
    "opencode": "OpenCode", "pi": "Pi", "qoder": "Qoder", "deepseek": "DeepSeek", "devin": "Devin",
]
func providerLabel(_ id: String) -> String { providerLabels[id] ?? id }
let agentProviders = ["claude", "codex", "bubble", "devin"]

struct ProviderGlyph: View {
    let provider: String
    var size: CGFloat = 16

    var body: some View {
        if UIImage(named: "provider-\(provider)") != nil {
            Image("provider-\(provider)")
                .resizable()
                // Devin's mark keeps its brand colors, like on the desktop.
                .renderingMode(provider == "devin" ? .original : .template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            Text(String(providerLabel(provider).prefix(1)))
                .font(.system(size: size * 0.62, weight: .semibold))
                .frame(width: size, height: size)
                .background(Color.fill3, in: .rect(cornerRadius: 4))
        }
    }
}

/// Mirrors the desktop handoff route: source → target.
struct SessionGlyph: View {
    let provider: String
    let from: String?

    var body: some View {
        if let from, from != provider {
            HStack(spacing: 2) {
                ProviderGlyph(provider: from)
                Image(systemName: "arrow.right").font(.system(size: 8, weight: .bold)).foregroundStyle(Color.text3)
                ProviderGlyph(provider: provider)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Handoff: \(providerLabel(from)) to \(providerLabel(provider))")
        } else {
            ProviderGlyph(provider: provider)
        }
    }
}

/// The desktop "working" shimmer on text.
struct Shimmer: ViewModifier {
    var active = true
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        if active {
            content
                .foregroundStyle(Color.text2)
                .overlay {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Color.text1.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.6)
                            .offset(x: phase * proxy.size.width * 1.4)
                    }
                    .mask(content)
                }
                .onAppear {
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1 }
                }
        } else {
            content
        }
    }
}

extension View {
    func shimmer(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }
}

/// Small status dot (green when the Mac is online).
struct StatusDot: View {
    let online: Bool
    var body: some View {
        Circle().fill(online ? Color.online : Color.text3).frame(width: 6, height: 6)
    }
}

enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}
