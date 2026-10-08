import AegisKit
import SwiftUI

@main
struct AegisApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            TextSizeRoot { RootView().environment(model) }
        }
    }
}

/// Sizes come from `Font.app`, which reads the Text Size setting when evaluated;
/// rebuilding on a change applies a new setting everywhere at once.
private struct TextSizeRoot<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var textSize
    @ViewBuilder let content: Content

    var body: some View { content.id(textSize) }
}

private struct CatalogKey: Equatable {
    let options: JSONValue?
    let models: [String: [String]]
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        Group {
            if model.paired {
                MainShell()
            } else if model.client.pairing != nil, model.client.connection == .confirming {
                ConfirmOnMacView()
            } else {
                WelcomeView()
                    .overlay(alignment: .top) { Banners().padding(.top, 8) }
            }
        }
        // Reachable while paired too (Settings › Pair again, or a pairing link), so a
        // broken or replaced pairing never strands the phone.
        .sheet(isPresented: $model.pairOpen) { PairSheet() }
        .tint(Color.text1)
        .preferredColorScheme(model.theme == "dark" ? .dark : model.theme == "light" ? .light : nil)
        .task {
            AppDelegate.model = model
            await model.refreshNotifications()
            await model.client.start()
        }
        .onChange(of: model.paired) { _, paired in
            if paired, let id = AppDelegate.pendingSession {
                AppDelegate.pendingSession = nil
                model.open(session: id)
            }
        }
        .task(id: CatalogKey(options: model.client.agentOptions, models: model.sessionModels)) { await model.reloadCatalogs() }
        .onChange(of: model.sessions, initial: true) { model.saveNotificationTitles() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.endBackground()
                Task { await model.client.foreground() }
                Task { await model.refreshNotifications() }
            case .background:
                model.beginBackground()
            default:
                break
            }
        }
        .onOpenURL { url in
            // A pairing link pre-fills the sheet; connecting stays a deliberate tap.
            let value = url.absoluteString
            guard value.hasPrefix("aegis://pair#") || value.hasPrefix("aegis-dev://pair#") else { return }
            model.pairText = value
            model.pairOpen = true
        }
    }
}

/// Width of the page column, for toolbar layout that can't size itself.
struct PageWidthKey: EnvironmentKey { static let defaultValue: CGFloat = 390 }
extension EnvironmentValues {
    var pageWidth: CGFloat {
        get { self[PageWidthKey.self] }
        set { self[PageWidthKey.self] = newValue }
    }
}

/// Picks the layout from the window's width: an unfolded iPhone Duo docks the
/// sidebar beside the page; a phone-sized window keeps the slide-over drawer.
private struct MainShell: View {
    @Environment(AppModel.self) private var model
    /// Wide enough for a 320 pt sidebar beside a phone-sized page.
    static let wideWidth: CGFloat = 700
    static let dockedWidth: CGFloat = 320

    var body: some View {
        GeometryReader { geo in
            let wide = geo.size.width >= Self.wideWidth
            Group {
                if wide {
                    DockedShell(pageWidth: geo.size.width - (model.sidebarHidden ? 0 : Self.dockedWidth))
                } else {
                    DrawerShell(screenWidth: geo.size.width)
                }
            }
            .onAppear { model.wideLayout = wide }
            .onChange(of: wide) { _, wide in
                model.wideLayout = wide
                model.drawerOpen = false
            }
        }
        .sheet(item: Bindable(model).approval) { ApprovalSheet(permission: $0) }
        .sheet(item: Bindable(model).diffReview) { DiffSheet(review: $0) }
    }
}

/// The page with its navigation stack, shared by both layouts.
private struct PageStack: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            content
                .navigationBarTitleDisplayMode(.inline)
                .overlay(alignment: .top) { Banners().padding(.top, 4) }
                .navigationDestination(for: AppModel.Route.self) { route in
                    switch route {
                    case .projects: ProjectsPage()
                    case .project(let id): ProjectPage(projectId: id)
                    case .settings: SettingsPage()
                    }
                }
        }
        .background(Color.page)
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .home: HomeView()
        case .session(let id): SessionView(sessionId: id).id(id)
        }
    }
}

/// Unfolded: sidebar and page side by side, like the desktop.
private struct DockedShell: View {
    @Environment(AppModel.self) private var model
    let pageWidth: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            if !model.sidebarHidden {
                DrawerView()
                    .frame(width: MainShell.dockedWidth)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                Rectangle().fill(Color.hair).frame(width: 0.5).ignoresSafeArea()
            }
            PageStack()
                .environment(\.pageWidth, pageWidth)
        }
        .animation(.interpolatingSpring(duration: 0.32, bounce: 0), value: model.sidebarHidden)
    }
}

/// ChatGPT-style shell: the sidebar sits behind the page, which slides aside.
private struct DrawerShell: View {
    @Environment(AppModel.self) private var model
    @GestureState private var drag: CGFloat = 0
    let screenWidth: CGFloat

    private var width: CGFloat { min(screenWidth * 0.82, 330) }

    var body: some View {
        @Bindable var model = model
        let base = model.drawerOpen ? width : 0
        let offset = min(width, max(0, base + drag))
        let progress = offset / width
        ZStack(alignment: .leading) {
            DrawerView()
                .frame(width: width)
                .offset(x: -width * 0.3 * (1 - progress))
                .opacity(Double(progress))

            PageStack()
            .environment(\.pageWidth, screenWidth)
            .overlay {
                Color.black.opacity(0.2 * Double(progress))
                    .ignoresSafeArea()
                    .allowsHitTesting(model.drawerOpen)
                    .onTapGesture { model.drawerOpen = false }
            }
            // The mask must cover the safe areas too: clipping to the view's own
            // frame cut off content under the status bar and home indicator, which
            // broke the scroll-edge glass into a hard band.
            .mask { RoundedRectangle(cornerRadius: progress > 0 ? 24 : 0).ignoresSafeArea() }
            .shadow(color: .black.opacity(0.12 * Double(progress)), radius: 12)
            .offset(x: offset)
            .simultaneousGesture(model.path.isEmpty ? drawerGesture : nil)
        }
        .animation(.interpolatingSpring(duration: 0.32, bounce: 0), value: model.drawerOpen)
        .onChange(of: model.drawerOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
        .ignoresSafeArea(.keyboard, edges: model.drawerOpen ? .bottom : [])
    }

    /// Edge swipe opens the sidebar; a left swipe closes it.
    private var drawerGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($drag) { value, state, _ in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if model.drawerOpen { state = min(0, value.translation.width) }
                else if value.startLocation.x < 28 { state = max(0, value.translation.width) }
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if !model.drawerOpen, value.startLocation.x < 28, value.translation.width > 60 { model.drawerOpen = true }
                if model.drawerOpen, value.translation.width < -60 { model.drawerOpen = false }
            }
    }
}

/// Opens the sidebar; each root screen places it first in its toolbar.
struct SidebarButton: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Button {
            if model.wideLayout { model.sidebarHidden.toggle() } else { model.drawerOpen = true }
        } label: {
            MenuGlyph().stroke(Color.ink, style: StrokeStyle(lineWidth: 1.7, lineCap: .round)).frame(width: 21, height: 21)
        }
        .accessibilityLabel(model.wideLayout ? (model.sidebarHidden ? "Show sidebar" : "Hide sidebar") : "Open sidebar")
    }
}

/// Two lines, the lower one shorter (the desktop sidebar mark).
struct MenuGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let u = rect.width / 24
        var path = Path()
        path.move(to: CGPoint(x: 4 * u, y: 8 * u)); path.addLine(to: CGPoint(x: 20 * u, y: 8 * u))
        path.move(to: CGPoint(x: 4 * u, y: 16 * u)); path.addLine(to: CGPoint(x: 15 * u, y: 16 * u))
        return path
    }
}
