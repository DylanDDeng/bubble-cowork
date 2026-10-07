import AegisKit
import SwiftUI

struct ProjectsPage: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        let shown = model.projects.filter { query.isEmpty || $0.name.lowercased().contains(query.trimmingCharacters(in: .whitespaces).lowercased()) }
        List {
            Section {
                ForEach(shown) { p in
                    let own = model.sessions.filter { $0.projectId == p.id }
                    let running = own.filter(\.isRunning).count
                    let waiting = model.permissions.filter { perm in own.contains { $0.id == perm.sessionId } }.count
                    let latest = own.map(\.updatedAt).max()
                    NavigationLink(value: AppModel.Route.project(p.id)) {
                        HStack(spacing: 14) {
                            Image(systemName: "folder").font(.system(size: 19)).frame(width: 42, height: 42).background(Color.fill2, in: .rect(cornerRadius: 13))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                                HStack(spacing: 6) {
                                    if running > 0 { ProgressView().controlSize(.mini) }
                                    Text((running > 0 ? "\(running) running · " : "") + "\(own.count) \(own.count == 1 ? "task" : "tasks")"
                                         + (running == 0 && latest != nil ? " · \(relativeTime(latest!))" : ""))
                                }
                                .font(.system(size: 13)).foregroundStyle(Color.text2)
                            }
                            Spacer(minLength: 4)
                            if waiting > 0 {
                                Text("\(waiting) need you").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.warn)
                                    .padding(.horizontal, 8).padding(.vertical, 3).background(Color.warnBg, in: .capsule)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                if shown.isEmpty {
                    Text(model.projects.isEmpty ? "No projects are shared yet." : "No matching projects.")
                        .foregroundStyle(Color.text2)
                }
            } footer: {
                Label("Only projects you share from Aegis on your Mac appear here. Change access in Settings → Connections on the Mac.", systemImage: "lock")
                    .font(.system(size: 13))
            }
        }
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Projects").font(.system(size: 16, weight: .semibold))
                    Text("Shared from \(model.macName)").font(.system(size: 12)).foregroundStyle(Color.text2)
                }
            }
        }
    }
}

struct ProjectPage: View {
    @Environment(AppModel.self) private var model
    let projectId: String

    var body: some View {
        let project = model.projects.first { $0.id == projectId }
        let own = model.sessions.filter { $0.projectId == projectId }.sorted { $0.updatedAt > $1.updatedAt }
        let waitingIds = Set(model.permissions.map(\.sessionId))
        let waiting = own.filter { waitingIds.contains($0.id) }
        let running = own.filter { $0.isRunning && !waitingIds.contains($0.id) }
        let earlier = own.filter { !waitingIds.contains($0.id) && !$0.isRunning }
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "folder").font(.system(size: 24)).frame(width: 52, height: 52).background(Color.fill2, in: .rect(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project?.name ?? "Project").font(.system(size: 26, weight: .bold)).lineLimit(1)
                        Text("\(own.count) \(own.count == 1 ? "task" : "tasks") · shared from \(model.macName)")
                            .font(.system(size: 13)).foregroundStyle(Color.text2)
                    }
                }
                .listRowBackground(Color.clear)
                Button { model.newTask(in: projectId) } label: {
                    Label("New task in \(project?.name ?? "project")", systemImage: "square.and.pencil")
                }
            }
            ForEach([("Needs you", waiting), ("Running", running), ("Earlier", earlier)], id: \.0) { title, items in
                if !items.isEmpty {
                    Section(title) {
                        ForEach(items) { s in
                            Button { model.open(session: s.id) } label: {
                                HStack(spacing: 10) {
                                    SessionGlyph(provider: s.provider, from: s.handoffSourceProvider)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(s.title.isEmpty ? "Untitled task" : s.title).font(.system(size: 16, weight: .medium)).lineLimit(1)
                                        Text(s.isRunning ? "Running" : relativeTime(s.updatedAt)).font(.system(size: 13)).foregroundStyle(Color.text2)
                                    }
                                    Spacer(minLength: 4)
                                    let trailing = SessionTrailing(session: s, waiting: model.permissions.first { $0.sessionId == s.id })
                                    if waitingIds.contains(s.id) || s.isRunning || s.isFailed { trailing } else {
                                        Image(systemName: "checkmark.circle").foregroundStyle(Color.text3)
                                    }
                                }
                                .foregroundStyle(Color.text1)
                            }
                        }
                    }
                }
            }
            if own.isEmpty {
                Text("No tasks in this project yet.").foregroundStyle(Color.text2)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New task in \(project?.name ?? "project")", systemImage: "square.and.pencil") { model.newTask(in: projectId) }
            }
        }
    }
}

struct SettingsPage: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRemove = false

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "laptopcomputer").font(.system(size: 22)).frame(width: 48, height: 48).background(Color.fill2, in: .circle)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.macName).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                        HStack(spacing: 6) {
                            StatusDot(online: model.ready)
                            Text("\(model.environmentLabel) · \(model.client.connection == .connected ? "Connected" : model.connectionText)")
                                .lineLimit(1)
                        }
                        .font(.system(size: 13)).foregroundStyle(Color.text2)
                    }
                    Spacer(minLength: 8)
                    HStack(spacing: 4) {
                        Image(systemName: "lock")
                        Text("Encrypted")
                    }
                    .font(.system(size: 12)).foregroundStyle(Color.text2).fixedSize()
                }
                .padding(.vertical, 4)
                .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                Button {
                    Task { await model.client.connect() }
                } label: {
                    HStack {
                        Text("Reconnect").foregroundStyle(Color.text1)
                        Spacer()
                        Image(systemName: "arrow.clockwise").foregroundStyle(Color.text3)
                    }
                }
                .disabled(model.busy)
                NavigationLink(value: AppModel.Route.projects) {
                    LabeledContent("Projects shared with this iPhone", value: "\(model.projects.count)")
                }
            } footer: {
                Text("Your Mac needs to stay awake and online. Closing the Aegis window doesn’t stop running tasks; project access is managed on the Mac.")
            }
            NotificationsSection()
            Section("Appearance") {
                Picker("Appearance", selection: $model.theme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                Button("Remove this Mac", role: .destructive) { confirmRemove = true }
            } footer: {
                Text("Clears this iPhone’s saved tasks and drafts. To revoke access, remove this iPhone in Aegis on your Mac.")
            }
            Section {
                Text("Aegis for iOS · Preview 0.2").font(.system(size: 12)).foregroundStyle(Color.text3)
                    .frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Remove \(model.macName) from this iPhone?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await model.removeMac() } }
        } message: {
            Text("Saved tasks and drafts on this iPhone are cleared.")
        }
    }
}

struct ApprovalSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let permission: RemotePermission
    @State private var request: RequestDescription?

    var body: some View {
        let session = model.sessions.first { $0.id == permission.sessionId }
        let live = model.permissions.contains { $0.requestId == permission.requestId }
        let enabled = model.ready && !model.busy && live
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "apple.terminal").font(.system(size: 19, weight: .semibold)).foregroundStyle(Color.warn)
                        .frame(width: 44, height: 44).background(Color.warnBg, in: .circle)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(permission.canApprove ? "Allow \(permission.toolName)?" : "Handle this on your Mac")
                            .font(.system(size: 20, weight: .semibold))
                        Text(session.map { "\(providerLabel($0.provider)) · \($0.title)" } ?? permission.toolName)
                            .font(.system(size: 13)).foregroundStyle(Color.text2).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if let request {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(request.label).font(.system(size: 13, weight: .medium)).foregroundStyle(Color.text3)
                        ScrollView {
                            Text(request.body).font(.system(size: 13.5, design: .monospaced)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 12)
                        }
                        .frame(maxHeight: 260)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(Color.code, in: .rect(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.hair, lineWidth: 0.5))
                    }
                    VStack(spacing: 0) {
                        fact("Tool", permission.toolName, mono: false)
                        ForEach(request.fields, id: \.self) { field in
                            Divider().padding(.leading, 14)
                            fact(field.first ?? "", field.last ?? "", mono: true)
                        }
                    }
                    .background(Color.code, in: .rect(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.hair, lineWidth: 0.5))
                }
                Label {
                    Text(!live ? "This request is no longer waiting. It was handled or the turn ended."
                         : permission.canApprove ? "Allows this request only. Your project’s permission settings stay the same."
                         : "Questions, plans and computer use need Aegis on your Mac. You can still deny it here.")
                } icon: { Image(systemName: "lock") }
                    .font(.system(size: 13)).foregroundStyle(Color.text2)
                HStack(spacing: 8) {
                    Button("Deny") { Task { await model.decide(permission, "deny") } }
                        .buttonStyle(PillButtonStyle(kind: .secondary, height: 52))
                        .background(Color.fill2, in: .capsule)
                        .disabled(!enabled)
                    if permission.canApprove {
                        Button("Allow once") {
                            Haptics.tap()
                            Task { await model.decide(permission, "allow") }
                        }
                        .buttonStyle(PillButtonStyle(kind: .primary, height: 52))
                        .disabled(!enabled)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task(id: permission.detail) { request = await model.core.describeRequest(permission.detail) }
    }

    private func fact(_ key: String, _ value: String, mono: Bool) -> some View {
        HStack {
            Text(key).foregroundStyle(Color.text2)
            Spacer(minLength: 12)
            Text(value).fontWeight(.medium).font(mono ? .system(size: 13, design: .monospaced) : .system(size: 14)).lineLimit(1)
        }
        .font(.system(size: 14))
        .padding(.horizontal, 14).padding(.vertical, 11)
    }
}

/// Offline, unconfirmed actions and errors, as glass capsules under the header.
struct Banners: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let notice = model.notice.isEmpty ? model.client.error : model.notice
        VStack(spacing: 8) {
            if model.client.connection == .offline {
                banner(icon: "icloud.slash", text: "\(model.macName) is offline", action: "Retry") { Task { await model.client.connect() } }
            }
            if model.unresolvedCount > 0 {
                let n = model.unresolvedCount
                banner(icon: "arrow.clockwise", text: "\(n) \(n == 1 ? "action is" : "actions are") on the way to your Mac", action: "Retry") {
                    Task { await model.client.reconcile() }
                }
            }
            if !notice.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                    Text(notice).frame(maxWidth: .infinity, alignment: .leading)
                    Button { model.dismissNotice() } label: {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(Color.danger)
                .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
                .glassEffect(.regular, in: .rect(cornerRadius: 20))
                .accessibilityAddTraits(.isStaticText)
            }
        }
        .padding(.horizontal, 16)
        .animation(.smooth, value: notice)
        .animation(.smooth, value: model.client.connection)
    }

    private func banner(icon: String, text: String, action: String, run: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(Color.text3)
            Text(text).frame(maxWidth: .infinity, alignment: .leading)
            Button(action, action: run)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.text1)
                .padding(.horizontal, 12).frame(height: 30)
                .background(Color.fill2, in: .capsule)
                .buttonStyle(.plain)
        }
        .font(.system(size: 13.5, weight: .medium))
        .padding(.leading, 14).padding(.trailing, 6).frame(minHeight: 40)
        .glassEffect(.regular, in: .capsule)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
