import AegisKit
import SwiftUI

/// New task: the desktop heading, what needs you, where it runs, the composer.
struct HomeView: View {
    @Environment(AppModel.self) private var model

    private var runningCount: Int { model.sessions.filter(\.isRunning).count }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 16) {
                Image("aegis-mark").resizable().renderingMode(.template).frame(width: 52, height: 52).foregroundStyle(Color.text1.opacity(0.3))
                heading
                if runningCount > 0 {
                    Button { model.drawerOpen = true } label: {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.mini)
                            Text("\(runningCount) \(runningCount == 1 ? "task" : "tasks") running")
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        }
                        .font(.system(size: 14)).foregroundStyle(Color.text2)
                        .padding(.horizontal, 14).frame(height: 34)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .capsule)
                }
            }
            .padding(.horizontal, 32)
            Spacer(minLength: 0)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                NeedsCards()
                ContextRows()
                Composer(
                    catalog: model.catalog(model.provider),
                    settings: model.newSettings,
                    onSettings: { model.setNewSettings($0) },
                    placeholder: "message to agent",
                    running: false,
                    canStop: false
                )
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SidebarButton() }
            ToolbarItem(placement: .principal) { AgentTitleMenu() }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New task", systemImage: "square.and.pencil") {
                    model.draft = ""
                    model.attachments = []
                }
            }
        }
    }

    /// Same wording as the desktop new-thread heading.
    @ViewBuilder private var heading: some View {
        if let project = model.selectedProject {
            VStack(spacing: 2) {
                Text(project.isRepo == false ? "What should we work on in" : "What should we build in")
                Menu {
                    Section("Projects") {
                        ForEach(model.projects) { p in
                            Button { model.projectId = p.id } label: {
                                if p.id == project.id { Label(p.name, systemImage: "checkmark") } else { Label(p.name, systemImage: "folder") }
                            }
                        }
                    }
                } label: {
                    Text("\(project.name)?")
                        .underline(pattern: .dot, color: Color.text3)
                        .foregroundStyle(Color.text1)
                }
            }
            .font(.system(size: 27))
            .multilineTextAlignment(.center)
        } else {
            Text(model.projects.isEmpty && model.paired && model.snapshot != nil
                 ? "No projects are shared with this iPhone. Share one from your Mac."
                 : "What should we build?")
                .font(.system(size: model.projects.isEmpty && model.snapshot != nil ? 17 : 27))
                .multilineTextAlignment(.center)
                .foregroundStyle(model.projects.isEmpty && model.snapshot != nil ? Color.text2 : Color.text1)
        }
    }
}

/// Header title: agent picker (glyph, name, model · effort).
private struct AgentTitleMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let r = model.catalog(model.provider).resolve(model.newSettings)
        Menu {
            Section("Agents on \(model.macName)") {
                ForEach(agentProviders, id: \.self) { p in
                    Button { model.provider = p } label: {
                        Label {
                            Text(providerLabel(p))
                            Text(model.describe(p))
                        } icon: {
                            Image(systemName: p == model.provider ? "checkmark" : "circle").opacity(p == model.provider ? 1 : 0)
                        }
                    }
                }
            }
            Section { Text("Uses the agents and sign-ins configured in Aegis on your Mac.") }
        } label: {
            VStack(spacing: 1) {
                HStack(spacing: 5) {
                    ProviderGlyph(provider: model.provider, size: 16)
                    Text(providerLabel(model.provider)).font(.system(size: 16, weight: .semibold))
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.text3)
                }
                Text(r.modelLabel + (r.effortLabel.map { " · \($0)" } ?? ""))
                    .font(.system(size: 12)).foregroundStyle(Color.text2).lineLimit(1)
            }
            .foregroundStyle(Color.text1)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Agent: \(providerLabel(model.provider))")
    }
}

/// Permission requests across tasks.
private struct NeedsCards: View {
    @Environment(AppModel.self) private var model
    @State private var summaries: [String: String] = [:]

    var body: some View {
        if !model.permissions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Needs you · \(model.permissions.count)").font(.system(size: 13, weight: .medium)).foregroundStyle(Color.text2)
                    .padding(.horizontal, 6)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.permissions) { p in
                            Button {
                                model.open(session: p.sessionId)
                                model.approval = p
                            } label: { card(p) }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .padding(.horizontal, -12)
            }
            .task(id: model.permissions) {
                for p in model.permissions where summaries[p.requestId] == nil {
                    summaries[p.requestId] = await model.core.describeRequest(p.detail).summary
                }
            }
        }
    }

    private func card(_ p: RemotePermission) -> some View {
        let question = p.toolName.lowercased().contains("question")
        return VStack(alignment: .leading, spacing: 3) {
            Label(question ? "Question" : p.canApprove ? "Approval" : "Needs your Mac", systemImage: question ? "questionmark" : "checkmark.shield")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.warn)
            Text(model.sessions.first { $0.id == p.sessionId }?.title ?? "Task")
                .font(.system(size: 15, weight: .semibold)).lineLimit(1)
            Text("\(p.toolName) · \(summaries[p.requestId] ?? "")")
                .font(.system(size: 13)).foregroundStyle(Color.text2).lineLimit(1)
        }
        .padding(.horizontal, 15).padding(.vertical, 13)
        .frame(width: 252, alignment: .leading)
        .background(Color.fill2, in: .rect(cornerRadius: 20))
    }
}

/// Where the new task runs: which Mac, and Local or a new worktree.
private struct ContextRows: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 0) {
            Button { model.push(.settings) } label: {
                row(icon: "laptopcomputer", value: model.macName) {
                    HStack(spacing: 5) {
                        StatusDot(online: model.ready)
                        Text(model.connectionText)
                    }
                }
            }
            .buttonStyle(.plain)
            Menu {
                Picker("Work in", selection: $model.worktree) {
                    Text("Local").tag(false)
                    Text("New worktree").tag(true)
                }
                .pickerStyle(.inline)
                Text(model.worktree ? "Starts in a fresh git worktree on its own branch" : "Uses your working copy")
            } label: {
                row(icon: "arrow.triangle.branch", value: model.worktree ? "New worktree" : "Local") {
                    Text(model.worktree ? "own branch" : "current branch")
                }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 4)
    }

    private func row(icon: String, value: String, @ViewBuilder detail: () -> some View) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 15)).frame(width: 20)
            Text(value).foregroundStyle(Color.text1)
            detail().font(.system(size: 13)).foregroundStyle(Color.text3)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.text3)
        }
        .font(.system(size: 15))
        .foregroundStyle(Color.text2)
        .padding(.horizontal, 6)
        .frame(height: 38)
        .contentShape(Rectangle())
    }
}
