import AegisKit
import SwiftUI

@main
struct AegisApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView().environment(model)
        }
    }
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
                    .sheet(isPresented: $model.pairOpen) { PairSheet() }
            }
        }
        .tint(Color.text1)
        .preferredColorScheme(model.theme == "dark" ? .dark : model.theme == "light" ? .light : nil)
        .task { await model.client.start() }
        .task(id: model.client.agentOptions) { await model.reloadCatalogs() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.client.foreground() } }
        }
        .onOpenURL { url in
            // A pairing link pre-fills the sheet; connecting stays a deliberate tap.
            let value = url.absoluteString
            guard value.hasPrefix("aegis://pair#") || value.hasPrefix("aegis-dev://pair#"), !model.paired else { return }
            model.pairText = value
            model.pairOpen = true
        }
    }
}

/// ChatGPT-style shell: the sidebar sits behind the page, which slides aside.
private struct MainShell: View {
    @Environment(AppModel.self) private var model
    @GestureState private var drag: CGFloat = 0

    private var width: CGFloat { min(UIScreen.main.bounds.width * 0.82, 330) }

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

            NavigationStack(path: $model.path) {
                content
                    .navigationBarTitleDisplayMode(.inline)
                    .overlay(alignment: .top) { Banners().padding(.top, 4) }
                    .navigationDestination(for: AppModel.Route.self) { route in
                        switch route {
                        case .projects: ProjectsPage()
                        case .project(let id): ProjectPage(projectId: id)
                        case .settings: SettingsPage()
                        case .diff(let sessionId, let itemId, let file): DiffPage(source: .turn(sessionId: sessionId, itemId: itemId), index: file)
                        case .stageDiff(let stageId, let file): DiffPage(source: .stage(stageId), index: file)
                        }
                    }
            }
            .background(Color.page)
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
        .sheet(item: $model.approval) { ApprovalSheet(permission: $0) }
        .onChange(of: model.drawerOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
        .ignoresSafeArea(.keyboard, edges: model.drawerOpen ? .bottom : [])
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .home: HomeView()
        case .session(let id): SessionView(sessionId: id).id(id)
        }
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
        Button { model.drawerOpen = true } label: {
            MenuGlyph().stroke(Color.ink, style: StrokeStyle(lineWidth: 1.7, lineCap: .round)).frame(width: 21, height: 21)
        }
        .accessibilityLabel("Open sidebar")
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
