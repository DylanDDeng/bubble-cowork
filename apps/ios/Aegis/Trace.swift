import AegisKit
import SwiftUI

// Phone rendering of the desktop work trace. Data and wording come from the
// shared desktop helpers (via AegisKit.CoreScript); only presentation is here.

func stageSymbol(_ kind: String?) -> String {
    switch kind {
    case "edit": return "pencil.line"
    case "command": return "apple.terminal"
    case "approval": return "exclamationmark.shield"
    case "error": return "xmark.circle"
    case "web": return "globe"
    case "memory": return "brain"
    case "other", "computer_use": return "powerplug"
    default: return "doc.text.magnifyingglass"
    }
}

private struct Disclosure: View {
    let label: String
    var detail: String? = nil
    @Binding var open: Bool
    var active = false
    var icon: String? = nil

    var body: some View {
        Button {
            withAnimation(.snappy(duration: 0.25)) { open.toggle() }
        } label: {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Color.text3) }
                (Text(label) + Text(detail ?? "").foregroundStyle(Color.text3))
                    .lineLimit(1)
                    .shimmer(active)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.text3)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .font(.system(size: 14))
            .foregroundStyle(Color.text2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}

/// Turn-level disclosure ("Worked for 1m 12s").
struct WorkBlockView: View {
    let work: WorkBlock
    @State private var open: Bool

    init(work: WorkBlock) {
        self.work = work
        _open = State(initialValue: work.defaultExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label = work.label {
                VStack(alignment: .leading, spacing: 8) {
                    Disclosure(label: label, open: $open)
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                }
            }
            if let stopped = work.stoppedLabel {
                VStack(alignment: .leading, spacing: 8) {
                    Text(stopped).font(.system(size: 14)).foregroundStyle(Color.text2)
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                }
            }
            if work.label == nil || open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(work.groups) { group in
                        switch group {
                        case .note(_, let markdown, let streaming):
                            MarkdownView(text: markdown, streaming: streaming)
                        case .thinking(_, let label, let active, let text):
                            ThinkingRow(label: label, active: active, text: text)
                        case .compaction(_, let inProgress, let label):
                            HStack(spacing: 8) {
                                if inProgress { ProgressView().controlSize(.mini) }
                                Text(label)
                            }
                            .font(.system(size: 14)).foregroundStyle(Color.text2)
                        case .stages(let stageGroup):
                            StageGroupView(group: stageGroup)
                        }
                    }
                    if work.working {
                        Text("Working").font(.system(size: 14)).shimmer()
                    }
                }
                .transition(.opacity)
            }
        }
    }
}

private struct ThinkingRow: View {
    let label: String
    let active: Bool
    let text: String
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Disclosure(label: label, open: $open, active: active)
            if open {
                Text(text)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.text2)
                    .lineSpacing(3)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.hair).frame(width: 1.5) }
                    .textSelection(.enabled)
            }
        }
    }
}

private struct StageGroupView: View {
    let group: StageGroup
    @State private var open: Bool

    init(group: StageGroup) {
        self.group = group
        _open = State(initialValue: group.defaultOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if group.showHeader {
                Disclosure(
                    label: group.headerLabel,
                    detail: group.failed > 0 ? " (\(group.failed) failed)" : nil,
                    open: $open,
                    active: group.headerActive,
                    icon: group.thinking ? nil : stageSymbol(group.headerIcon)
                )
            }
            if !group.showHeader || open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(group.stages) { stage in
                        if stage.kind == .subagents { SubagentsView(stage: stage) } else { StageRow(stage: stage) }
                    }
                }
                .padding(.leading, group.showHeader ? 12 : 0)
                .overlay(alignment: .leading) {
                    if group.showHeader { Rectangle().fill(Color.hair).frame(width: 1.5).padding(.leading, 6) }
                }
            }
            if !group.showHeader && group.thinking {
                Text("Thinking").font(.system(size: 14)).shimmer()
            }
        }
    }
}

private struct StageRow: View {
    let stage: Stage
    @State private var open: Bool

    init(stage: Stage) {
        self.stage = stage
        _open = State(initialValue: stage.defaultOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    if stage.status == "pending" {
                        ProgressView().controlSize(.mini).frame(width: 15)
                    } else {
                        Image(systemName: stageSymbol(stage.icon))
                            .font(.system(size: 13))
                            .foregroundStyle(stage.status == "waiting" ? Color.warn : Color.text3)
                            .frame(width: 15)
                    }
                    Text(stage.title)
                        .lineLimit(1)
                        .foregroundStyle(stage.active ? Color.text1 : Color.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if stage.icon == "edit", stage.addedLines + stage.removedLines > 0 {
                        DiffCounts(added: stage.addedLines, removed: stage.removedLines)
                    }
                    if stage.status == "error" { Image(systemName: "exclamationmark.circle").font(.system(size: 12)).foregroundStyle(Color.danger) }
                    if stage.status == "waiting" { Image(systemName: "exclamationmark.shield").font(.system(size: 12)).foregroundStyle(Color.warn) }
                    if stage.status == "interrupted" { Image(systemName: "circle.dashed").font(.system(size: 12)).foregroundStyle(Color.text3) }
                    if stage.expandable && stage.status != "waiting" {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.text3)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                .font(.system(size: 14))
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!stage.expandable)
            if open && stage.expandable {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(stage.files) { file in
                        if file.patch != nil {
                            InlineEditDiff(stage: stage, file: file)
                        } else {
                            HStack(spacing: 8) {
                                Text(file.name).font(.system(size: 12.5, design: .monospaced)).lineLimit(1)
                                if file.addedLines + file.removedLines > 0 { DiffCounts(added: file.addedLines, removed: file.removedLines) }
                            }
                            .foregroundStyle(Color.text2)
                        }
                    }
                    ForEach(stage.commands) { command in
                        OutputBlock(text: command.text, isError: command.isError)
                    }
                    if !stage.genericText.isEmpty { OutputBlock(text: stage.genericText, isError: false) }
                }
                .padding(.leading, 23)
                .padding(.bottom, 6)
            }
        }
    }
}

/// Desktop InlineEditDiff: the file's first changed lines under its name;
/// tapping opens the full diff of every file in the stage.
private struct InlineEditDiff: View {
    @Environment(AppModel.self) private var model
    let stage: Stage
    let file: Stage.File
    @State private var lines: [DiffFile.Line] = []
    @State private var hidden = 0
    private let limit = 8

    var body: some View {
        Button {
            Haptics.tap()
            Task { await model.openStageDiff(stage, file: file) }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text").font(.system(size: 12)).foregroundStyle(Color.text3)
                    Text(file.name).font(.system(size: 12.5, weight: .medium, design: .monospaced)).foregroundStyle(Color.text1).lineLimit(1)
                    Spacer(minLength: 4)
                    DiffCounts(added: file.addedLines, removed: file.removedLines)
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.text3)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                if !lines.isEmpty {
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            HStack(spacing: 0) {
                                Text(line.type == "add" ? "+" : line.type == "del" ? "−" : " ").frame(width: 16)
                                Text(line.text).lineLimit(1)
                            }
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(line.type == "add" ? Color.add : line.type == "del" ? Color.del : Color.text2)
                            .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
                            .background(line.type == "add" ? Color.addBg : line.type == "del" ? Color.delBg : .clear)
                        }
                        if hidden > 0 {
                            Text("\(hidden) more \(hidden == 1 ? "line" : "lines")")
                                .font(.system(size: 11.5)).foregroundStyle(Color.text3)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .background(Color.code, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.hair, lineWidth: 0.5))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open diff of \(file.name)")
        .task(id: file.diff) {
            guard let patch = file.patch else { return }
            // Changed lines with one line of context, like a hunk preview.
            let all = (await model.core.parsePatch(patch)).flatMap(\.lines).filter { $0.type != "hunk" }
            var keep = IndexSet()
            for (i, line) in all.enumerated() where line.type != "ctx" {
                keep.insert(integersIn: max(0, i - 1)...min(all.count - 1, i + 1))
            }
            var picked = keep.map { all[$0] }
            // Drop the indentation the shown lines share, so the change itself is visible.
            let indent = picked.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
                .map { $0.text.prefix { $0 == " " || $0 == "\t" }.count }.min() ?? 0
            if indent > 0 {
                picked = picked.map { DiffFile.Line(type: $0.type, oldNo: $0.oldNo, newNo: $0.newNo, text: String($0.text.dropFirst(min(indent, $0.text.count)))) }
            }
            lines = Array(picked.prefix(limit))
            hidden = max(0, picked.count - limit)
        }
    }
}

private struct OutputBlock: View {
    let text: String
    let isError: Bool

    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(isError ? Color.danger : Color.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .frame(maxHeight: 220)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.code, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.hair, lineWidth: 0.5))
    }
}

struct DiffCounts: View {
    let added: Int
    let removed: Int
    var body: some View {
        HStack(spacing: 4) {
            Text("+\(added)").foregroundStyle(Color.add)
            Text("−\(removed)").foregroundStyle(Color.del)
        }
        .font(.system(size: 12.5, design: .monospaced))
        .fixedSize()
    }
}

private struct SubagentsView: View {
    let stage: Stage

    var body: some View {
        if let board = stage.board {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 13))
                    Text(board.title).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(board.meta).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.text3)
                }
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.fill2)
                ForEach(stage.lanes) { lane in
                    Divider().overlay(Color.hair)
                    LaneRow(lane: lane).padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
            .clipShape(.rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.hair, lineWidth: 0.5))
            .padding(.vertical, 2)
        } else {
            ForEach(stage.lanes) { lane in LaneRow(lane: lane).padding(.vertical, 3) }
        }
    }
}

private struct LaneRow: View {
    let lane: Stage.Lane

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                if let provider = lane.provider { ProviderGlyph(provider: provider, size: 13) } else {
                    Image(systemName: "cpu").font(.system(size: 12)).foregroundStyle(Color.text3)
                }
                Text(lane.label).lineLimit(1)
            }
            .font(.system(size: 13))
            .foregroundStyle(Color.text2)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Color.fill2, in: .capsule)
            .overlay(Capsule().strokeBorder(Color.hair, lineWidth: 0.5))
            Spacer(minLength: 4)
            if lane.status == "running" {
                HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("running") }
                    .font(.system(size: 12)).foregroundStyle(Color.text3)
            } else {
                Text(lane.status).font(.system(size: 12)).foregroundStyle(lane.status == "failed" ? Color.danger : Color.text3)
            }
        }
    }
}
