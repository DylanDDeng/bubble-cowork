import AegisKit
import SwiftUI

/// Sidebar order: needs you, running, then recency buckets.
func groupSessions(_ sessions: [RemoteSession], _ permissions: [RemotePermission], now: Date = Date()) -> [(title: String, items: [RemoteSession])] {
    let waiting = Set(permissions.map(\.sessionId))
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
    let day = 86_400_000.0
    var groups: [(String, [RemoteSession])] = [("Needs you", []), ("Running", []), ("Today", []), ("Yesterday", []), ("Previous 7 days", []), ("Earlier", [])]
    for s in sessions.sorted(by: { $0.updatedAt > $1.updatedAt }) {
        let index = waiting.contains(s.id) ? 0 : s.isRunning ? 1 : s.updatedAt >= today ? 2 : s.updatedAt >= today - day ? 3 : s.updatedAt >= today - 7 * day ? 4 : 5
        groups[index].1.append(s)
    }
    return groups.filter { !$0.1.isEmpty }.map { (title: $0.0, items: $0.1) }
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

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = q.isEmpty ? model.sessions : model.sessions.filter { $0.title.lowercased().contains(q) }
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
                        row(icon: "square.and.pencil", label: "New task") { model.openHome() }
                        row(icon: "folder", label: "Projects", count: model.projects.count, chevron: true) { model.push(.projects) }
                    }
                    ForEach(groupSessions(filtered, model.permissions), id: \.title) { group in
                        Text(group.title).font(.app(13, weight: .medium)).foregroundStyle(Color.text3)
                            .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 6)
                        ForEach(group.items) { s in
                            Button { model.open(session: s.id) } label: {
                                HStack(spacing: 10) {
                                    SessionGlyph(provider: s.provider, from: s.handoffSourceProvider)
                                    Text(s.title.isEmpty ? "Untitled task" : s.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
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
                    }
                    if !q.isEmpty && filtered.isEmpty {
                        Text("No matching tasks.").font(.app(14)).foregroundStyle(Color.text2).padding(10)
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

    private func row(icon: String, label: String, count: Int? = nil, chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.app(16)).frame(width: 22)
                Text(label).frame(maxWidth: .infinity, alignment: .leading)
                if let count { Text("\(count)").font(.app(13)).foregroundStyle(Color.text3) }
                if chevron { Image(systemName: "chevron.right").font(.app(12, weight: .semibold)).foregroundStyle(Color.text3) }
            }
            .font(.app(15))
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
