import AegisKit
import SwiftUI

struct SessionView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String

    @State private var rendered = SessionModel.empty
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var atBottom = true
    @State private var copied = false
    @State private var loadingOlder = false

    private var session: RemoteSession? { model.sessions.first { $0.id == sessionId } }
    private var history: RemoteSnapshot? { model.client.messagesBySession[sessionId] }
    private var messages: [RemoteMessage] { history?.messages ?? [] }
    private var running: Bool { session?.isRunning ?? false }
    private var permissions: [RemotePermission] { model.permissions.filter { $0.sessionId == sessionId } }

    private struct RenderKey: Equatable {
        let messages: [RemoteMessage]
        let running: Bool
        let status: String
    }

    /// Sends the Mac hasn't recorded yet, shown with their delivery state.
    private var pendingSends: [(id: String, prompt: String, result: CommandResult)] {
        model.client.operations.compactMap { id, op in
            guard op.method == "send", op.sessionId == sessionId, op.result.state != .completed, let prompt = op.prompt,
                  !messages.contains(where: { $0.role == "user" && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt.trimmingCharacters(in: .whitespacesAndNewlines) })
            else { return nil }
            return (id, prompt, op.result)
        }
        .sorted { $0.id < $1.id }
    }

    var body: some View {
        ScrollView {
            // A plain stack on purpose: LazyVStack re-estimates off-screen row
            // heights, and with bottom anchoring and rows whose height changes
            // (markdown, traces, async diff previews) the estimates never settled,
            // freezing the app at 100% CPU. History is paged, so rows are few.
            VStack(alignment: .leading, spacing: 18) {
                if history?.before != nil {
                    Button(loadingOlder ? "Loading…" : "Load earlier messages") {
                        loadingOlder = true
                        Task {
                            await model.perform { try await model.client.older() }
                            loadingOlder = false
                        }
                    }
                    .font(.system(size: 13)).foregroundStyle(Color.text2)
                    .frame(maxWidth: .infinity)
                    .disabled(loadingOlder)
                }
                if messages.isEmpty {
                    Text(model.ready ? "Loading messages…" : "Messages update when your Mac is back.")
                        .font(.system(size: 14)).foregroundStyle(Color.text2)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                ForEach(rendered.items) { item in
                    ItemView(item: item, sessionId: sessionId)
                }
                ForEach(pendingSends, id: \.id) { pending in
                    VStack(alignment: .trailing, spacing: 6) {
                        UserBubble(prompt: pending.prompt)
                        OpStatus(result: pending.result)
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                ForEach(permissions) { permission in
                    ApprovalCard(permission: permission)
                }
                if !running, session?.isFailed == true {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Turn failed", systemImage: "exclamationmark.circle").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.danger)
                        Text("Details are in Aegis on your Mac.").font(.system(size: 14))
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.dangerBg, in: .rect(cornerRadius: 20))
                }
                if !running, session?.isFailed != true, let answer = rendered.lastAnswerText, !answer.isEmpty,
                   !messages.isEmpty, !isUserLast {
                    Button {
                        UIPasteboard.general.string = answer
                        copied = true
                        Haptics.tap()
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            copied = false
                        }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "square.on.square")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.text2)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copied ? "Copied" : "Copy response")
                    .padding(.top, -10)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
        // Tapping the conversation puts the composer away, like a drag does.
        .simultaneousGesture(TapGesture().onEnded {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        })
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            geo.contentSize.height - geo.visibleRect.maxY
        } action: { _, distance in
            // Hysteresis: a boundary value must not flip the state back and forth.
            if atBottom, distance > 140 { atBottom = false }
            else if !atBottom, distance < 80 { atBottom = true }
        }
        .task(id: RenderKey(messages: messages, running: running, status: session?.status ?? "")) {
            let next = await model.core.renderSession(messages: messages, running: running, status: session?.status ?? "")
            let follow = atBottom
            rendered = next
            if follow { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: model.sendTick) {
            withAnimation { position.scrollTo(edge: .bottom) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                if running && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Draft saved · send it after this turn").font(.system(size: 12.5)).foregroundStyle(Color.text2)
                }
                if let session {
                    Composer(
                        catalog: model.catalog(session.provider),
                        settings: model.settings(forSession: sessionId),
                        onSettings: { model.setSettings($0, forSession: sessionId) },
                        placeholder: !permissions.isEmpty ? "Resolve this approval request to continue"
                            : running ? "Ask for follow-up changes" : "message to agent",
                        running: running,
                        canStop: model.ready && !model.busy && session.runId != nil
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
            // An overlay, not part of the inset: showing it must not change the
            // scroll geometry that decides whether it shows (that looped forever).
            .overlay(alignment: .top) {
                Group {
                    if !atBottom && !rendered.items.isEmpty {
                        Button {
                            withAnimation { position.scrollTo(edge: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.ink).frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel("Jump to latest")
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                    }
                }
                .offset(y: -56)
                .animation(.smooth(duration: 0.2), value: atBottom)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SidebarButton() }
            // Title sits next to the sidebar button, without a glass background.
            ToolbarItem(placement: .topBarLeading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(session?.title ?? "Task").font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        Text(model.projects.first { $0.id == session?.projectId }?.name ?? "Project")
                        Text("·").foregroundStyle(Color.text3)
                        if model.client.connection == .connected && model.client.freshness != .current {
                            ProgressView().controlSize(.mini)
                        } else {
                            StatusDot(online: model.ready)
                        }
                        Text(model.macName + (model.client.connection != .connected ? " offline" : ""))
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(Color.text2)
                    .lineLimit(1)
                }
                // Toolbar items size to their minimum; give the title the room
                // between the sidebar button and the trailing capsule.
                .frame(width: max(120, UIScreen.main.bounds.width - 224), alignment: .leading)
                .padding(.leading, 4)
            }
            .sharedBackgroundVisibility(.hidden)
            // Grouped into one glass capsule, like the system toolbars.
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("New task in this project", systemImage: "square.and.pencil") {
                    model.newTask(in: session?.projectId)
                }
                Menu {
                    if let projectId = session?.projectId {
                        Button("Open project", systemImage: "folder") { model.push(.project(projectId)) }
                    }
                    if let answer = rendered.lastAnswerText, !answer.isEmpty {
                        Button("Copy last response", systemImage: "square.on.square") {
                            UIPasteboard.general.string = answer
                            Haptics.tap()
                        }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.client.refresh() } }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
            }
        }
    }

    private var isUserLast: Bool {
        if case .user = rendered.items.last { return true }
        return false
    }
}

struct UserBubble: View {
    let prompt: String
    var attachments: [Attachment] = []

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !attachments.isEmpty {
                HStack(spacing: 6) {
                    ForEach(attachments) { a in
                        Label(a.name, systemImage: a.image ? "photo" : "doc")
                            .font(.system(size: 12.5)).foregroundStyle(Color.text2).lineLimit(1)
                            .padding(.horizontal, 10).frame(height: 28)
                            .overlay(Capsule().strokeBorder(Color.hair, lineWidth: 0.5))
                    }
                }
            }
            Text(prompt)
                .font(.system(size: 16))
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Color.fill2, in: .rect(cornerRadius: 22))
        }
        .frame(maxWidth: 320, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct ItemView: View {
    @Environment(AppModel.self) private var model
    let item: SessionItem
    let sessionId: String

    var body: some View {
        switch item {
        case .user(_, let prompt, let attachments):
            UserBubble(prompt: prompt, attachments: attachments)
        case .answer(_, let markdown, let streaming):
            MarkdownView(text: markdown, streaming: streaming)
        case .plan(_, let markdown):
            VStack(alignment: .leading, spacing: 8) {
                Text("Proposed plan").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.text2)
                MarkdownView(text: markdown)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hair, lineWidth: 0.5))
        case .changes(let itemId, let files):
            ChangesCard(files: files) { index in model.push(.diff(sessionId: sessionId, itemId: itemId, file: index)) }
        case .work(_, let work):
            WorkBlockView(work: work)
        case .activity(_, let steps):
            LegacyActivity(steps: steps)
        case .working(_, let label):
            Text(label).font(.system(size: 14)).shimmer()
        }
    }
}

private struct LegacyActivity: View {
    let steps: [SessionItem.Step]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.system(size: 14)).foregroundStyle(Color.text2)
            }
            .buttonStyle(.plain)
            if open {
                ForEach(steps) { step in
                    Text(step.detail).font(.system(size: 12, design: .monospaced))
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.code, in: .rect(cornerRadius: 12))
                }
            }
        }
    }
}

private struct ChangesCard: View {
    let files: [ChangedFile]
    let onOpen: (Int) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(files.count) \(files.count == 1 ? "file" : "files") changed").font(.system(size: 14, weight: .semibold))
                Spacer()
                DiffCounts(added: files.reduce(0) { $0 + $1.additions }, removed: files.reduce(0) { $0 + $1.deletions })
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            ForEach(Array(files.enumerated()), id: \.offset) { index, file in
                Divider().overlay(Color.hair)
                Button { onOpen(index) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text").font(.system(size: 15)).foregroundStyle(Color.text3)
                        Text(file.path).font(.system(size: 13, design: .monospaced)).lineLimit(1).truncationMode(.head)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        DiffCounts(added: file.additions, removed: file.deletions)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.text3)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Color.page, in: .rect(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hair, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
    }
}

private struct OpStatus: View {
    @Environment(AppModel.self) private var model
    let result: CommandResult

    var body: some View {
        Group {
            switch result.state {
            case .rejected:
                Label("Not sent · \(result.error ?? "Rejected by your Mac")", systemImage: "exclamationmark.circle")
                    .foregroundStyle(Color.warn)
            case .accepted:
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Accepted by your Mac") }
                    .foregroundStyle(Color.text2)
            default:
                HStack(spacing: 6) {
                    Label("Couldn’t confirm delivery", systemImage: "exclamationmark.circle")
                    Button("Check") { Task { await model.client.reconcile() } }
                        .fontWeight(.semibold).underline()
                }
                .foregroundStyle(Color.warn)
            }
        }
        .font(.system(size: 12.5))
    }
}

/// Inline card for a live permission request in this task.
struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    let permission: RemotePermission
    @State private var summary = ""

    var body: some View {
        Group {
            if permission.canApprove {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.shield").foregroundStyle(Color.warn)
                        Text("Approval needed").fontWeight(.semibold)
                        Text("· \(permission.toolName)").foregroundStyle(Color.text2)
                    }
                    .font(.system(size: 14))
                    Text(summary.isEmpty ? permission.toolName : summary)
                        .font(.system(size: 13, design: .monospaced)).lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.page, in: .rect(cornerRadius: 12))
                    HStack(spacing: 8) {
                        Button("Deny") { Task { await model.decide(permission, "deny") } }
                            .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                        Button("Review") { model.approval = permission }
                            .buttonStyle(PillButtonStyle(kind: .primary))
                    }
                }
                .padding(14)
                .background(Color.fill2, in: .rect(cornerRadius: 22))
            } else {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "laptopcomputer").font(.system(size: 16))
                        .frame(width: 34, height: 34).background(Color.fill2, in: .circle)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(deskTitle).font(.system(size: 14, weight: .semibold))
                        Text("This request can’t be answered from iPhone yet. Open Aegis on your Mac to continue.")
                            .font(.system(size: 13.5)).foregroundStyle(Color.text2)
                        HStack(spacing: 8) {
                            Button("View request") { model.approval = permission }.buttonStyle(PillButtonStyle(kind: .secondary))
                            Button("Deny") { Task { await model.decide(permission, "deny") } }
                                .buttonStyle(PillButtonStyle(kind: .secondary)).disabled(!model.ready)
                        }
                        .padding(.top, 6)
                    }
                }
                .padding(14)
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hair, lineWidth: 0.5))
            }
        }
        .task(id: permission.detail) { summary = await model.core.describeRequest(permission.detail).summary }
    }

    private var deskTitle: String {
        let tool = permission.toolName.lowercased()
        if tool.contains("question") { return "The agent has a question" }
        if tool.contains("plan") { return "Plan ready for review" }
        return "\(permission.toolName) needs your Mac"
    }
}

struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    let kind: Kind
    var height: CGFloat = 40
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .foregroundStyle(kind == .primary ? Color.onInk : Color.text1)
            .background(kind == .primary ? Color.ink : Color.page, in: .capsule)
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}
