import AegisKit
import SwiftUI

/// One sidebar section: "Needs you", "Pinned", or a project with its sessions.
struct SidebarSection: Identifiable {
    enum Kind: Equatable { case waiting, pinned, project(RemoteProject?) }
    let id: String
    let kind: Kind
    let items: [RemoteSession]
}

/// Sidebar order, like the desktop grouped by project: sessions waiting on you,
/// pinned ones, then each project (most recently active first). A session shows
/// once, in the first section it belongs to.
func sidebarSections(_ sessions: [RemoteSession], projects: [RemoteProject], permissions: [RemotePermission]) -> [SidebarSection] {
    let waiting = Set(permissions.map(\.sessionId))
    let recent = sessions.sorted { $0.updatedAt > $1.updatedAt }
    let needsYou = recent.filter { waiting.contains($0.id) }
    let pinned = recent.filter { $0.isPinned && !waiting.contains($0.id) }
    let rest = recent.filter { !$0.isPinned && !waiting.contains($0.id) }
    var sections: [SidebarSection] = []
    if !needsYou.isEmpty { sections.append(SidebarSection(id: "waiting", kind: .waiting, items: needsYou)) }
    if !pinned.isEmpty { sections.append(SidebarSection(id: "pinned", kind: .pinned, items: pinned)) }
    var order: [String] = []
    var byProject: [String: [RemoteSession]] = [:]
    for session in rest {
        if byProject[session.projectId] == nil { order.append(session.projectId) }
        byProject[session.projectId, default: []].append(session)
    }
    // Projects without sessions left to show still appear, so a new task can start there.
    for project in projects where byProject[project.id] == nil && !order.contains(project.id) {
        order.append(project.id)
        byProject[project.id] = []
    }
    for id in order {
        sections.append(SidebarSection(id: "project-" + id, kind: .project(projects.first { $0.id == id }), items: byProject[id] ?? []))
    }
    return sections
}

func relativeTime(_ ms: Double, now: Date = Date()) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let diff = max(0, now.timeIntervalSince(date))
    if diff < 60 { return "Just now" }
    if diff < 3600 { return "\(Int(diff / 60)) min ago" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today, " + date.formatted(date: .omitted, time: .shortened) }
    if calendar.isDateInYesterday(date) { return "Yesterday" }
    return date.formatted(.dateTime.month(.abbreviated).day())
}

/// Trailing state for a task row: approval, running, failed.
struct SessionTrailing: View {
    let session: RemoteSession
    let waiting: RemotePermission?

    var body: some View {
        if let waiting {
            Text(waiting.canApprove ? "Approve" : "On Mac")
                .font(.app(12, weight: .semibold)).foregroundStyle(Color.warn)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.warnBg, in: .capsule)
        } else if session.isRunning {
            ProgressView().controlSize(.small)
        } else if session.isFailed {
            Text("Failed").font(.app(12, weight: .medium)).foregroundStyle(Color.danger)
        }
    }
}

struct DrawerView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    /// Projects the user folded; remembered across launches.
    @AppStorage("aegis-sidebar-collapsed") private var collapsedRaw = ""
    @State private var expanded: Set<String> = []

    private static let previewCount = 5
    private var collapsed: Set<String> { Set(collapsedRaw.split(separator: "\n").map(String.init)) }

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color.text3)
                    TextField("Search tasks", text: $query).submitLabel(.search)
                }
                .padding(.horizontal, 14)
                .frame(height: 42)
                .background(Color.fill2, in: .capsule)
                Button { model.openHome() } label: {
                    Image(systemName: "square.and.pencil").font(.app(17, weight: .medium)).foregroundStyle(Color.ink).frame(width: 42, height: 42)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("New task")
            }
            .padding(.horizontal, 14)
            .padding(.top, 4)
            .padding(.bottom, 8)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if q.isEmpty {
                        ForEach(sidebarSections(model.sessions, projects: model.projects, permissions: model.permissions)) { section in
                            sectionView(section)
                        }
                    } else {
                        let found = model.sessions.filter { $0.title.lowercased().contains(q) }.sorted { $0.updatedAt > $1.updatedAt }
                        ForEach(found) { s in sessionRow(s, project: projectName(s.projectId)) }
                        if found.isEmpty {
                            Text("No matching tasks.").font(.app(14)).foregroundStyle(Color.text2).padding(10)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.immediately)

            Button { model.push(.settings) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "laptopcomputer").font(.app(17)).frame(width: 38, height: 38).background(Color.fill2, in: .circle)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.macName).font(.app(15, weight: .semibold))
                        HStack(spacing: 5) {
                            StatusDot(online: model.ready)
                            Text("\(model.environmentLabel) · \(model.connectionText)")
                        }
                        .font(.app(12)).foregroundStyle(Color.text2)
                    }
                    Spacer()
                    Image(systemName: "gearshape").foregroundStyle(Color.text3)
                }
                .padding(10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .overlay(alignment: .top) { Rectangle().fill(Color.hair).frame(height: 0.5) }
            .padding(.horizontal, 8)
        }
        .foregroundStyle(Color.text1)
        .background(Color.page)
    }

    @ViewBuilder private func sectionView(_ section: SidebarSection) -> some View {
        switch section.kind {
        case .waiting:
            sectionTitle("Needs you")
            ForEach(section.items) { s in sessionRow(s, project: projectName(s.projectId)) }
        case .pinned:
            sectionTitle("Pinned")
            ForEach(section.items) { s in sessionRow(s, project: projectName(s.projectId)) }
        case .project(let project):
            let id = section.id
            let folded = collapsed.contains(id)
            let showAll = expanded.contains(id)
            HStack(spacing: 8) {
                Button { toggleCollapsed(id) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: folded ? "folder" : "folder.fill").font(.app(14)).foregroundStyle(Color.text2).frame(width: 18)
                        Text(project?.name ?? "Other").font(.app(14, weight: .semibold)).lineLimit(1)
                        Image(systemName: "chevron.right").font(.app(10, weight: .bold)).foregroundStyle(Color.text3)
                            .rotationEffect(.degrees(folded ? 0 : 90))
                        Spacer(minLength: 4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(project?.name ?? "Other"), \(section.items.count) tasks")
                .accessibilityValue(folded ? "Collapsed" : "Expanded")
                if let project {
                    Button {
                        model.projectId = project.id
                        model.openHome()
                    } label: {
                        Image(systemName: "plus").font(.app(13, weight: .semibold)).foregroundStyle(Color.text2).frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("New task in \(project.name)")
                }
            }
            .padding(.leading, 10)
            .padding(.top, 14)
            .padding(.bottom, 2)
            if !folded {
                let shown = showAll ? section.items : Array(section.items.prefix(Self.previewCount))
                ForEach(shown) { s in sessionRow(s, project: nil) }
                if section.items.isEmpty {
                    Text("No tasks yet").font(.app(13)).foregroundStyle(Color.text3).padding(.horizontal, 10).padding(.vertical, 6)
                } else if section.items.count > Self.previewCount {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) {
                            if showAll { expanded.remove(id) } else { expanded.insert(id) }
                        }
                    } label: {
                        Text(showAll ? "Show less" : "Show \(section.items.count - Self.previewCount) more")
                            .font(.app(13)).foregroundStyle(Color.text2)
                            .padding(.horizontal, 10).frame(minHeight: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.app(13, weight: .medium)).foregroundStyle(Color.text3)
            .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 6)
    }

    /// `project`: shown under the title where sessions from several projects mix.
    private func sessionRow(_ s: RemoteSession, project: String?) -> some View {
        Button { model.open(session: s.id) } label: {
            HStack(spacing: 10) {
                SessionGlyph(provider: s.provider, from: s.handoffSourceProvider)
                VStack(alignment: .leading, spacing: 1) {
                    Text(s.title.isEmpty ? "Untitled task" : s.title).lineLimit(1)
                    if let project {
                        Text(project).font(.app(12)).foregroundStyle(Color.text3).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                SessionTrailing(session: s, waiting: model.permissions.first { $0.sessionId == s.id })
            }
            .font(.app(15, weight: model.currentSessionId == s.id ? .medium : .regular))
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .background(model.currentSessionId == s.id ? Color.fill2 : .clear, in: .rect(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func projectName(_ id: String) -> String? { model.projects.first { $0.id == id }?.name }

    private func toggleCollapsed(_ id: String) {
        var set = collapsed
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
        withAnimation(.snappy(duration: 0.2)) { collapsedRaw = set.sorted().joined(separator: "\n") }
    }
}
