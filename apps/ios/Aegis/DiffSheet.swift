import AegisKit
import SwiftUI

/// Files to review in the diff sheet, opened from a turn's changes card or an
/// edit stage in the work trace.
struct DiffReview: Identifiable {
    let id = UUID()
    let files: [DiffFile]
    /// Path of the file to scroll to first.
    var focus: String?
    /// The session's project, for All Files and opening files.
    var projectId: String?

    var additions: Int { files.reduce(0) { $0 + $1.additions } }
    var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

/// One `@@` block of a file diff.
struct DiffHunk: Identifiable {
    let id: Int
    let range: String
    let additions: Int
    let deletions: Int
    let lines: [DiffFile.Line]

    static func split(_ file: DiffFile) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var lines: [DiffFile.Line] = []
        var started = false
        func flush() {
            guard started || !lines.isEmpty else { return }
            let numbers = lines.compactMap { $0.newNo ?? $0.oldNo }
            let range = numbers.min().map { first in
                let last = numbers.max() ?? first
                return first == last ? "Line \(first)" : "Lines \(first)-\(last)"
            } ?? "Lines"
            hunks.append(DiffHunk(id: hunks.count, range: range,
                                  additions: lines.filter { $0.type == "add" }.count,
                                  deletions: lines.filter { $0.type == "del" }.count, lines: lines))
            lines = []
        }
        for line in file.lines {
            if line.type == "hunk" { flush(); started = true } else { lines.append(line) }
        }
        flush()
        return hunks
    }
}

/// Codex-style review sheet: Modified (every changed file in one scroll) and
/// All Files (the project tree, searchable, read-only).
struct DiffSheet: View {
    let review: DiffReview
    @Environment(\.dismiss) private var dismiss
    @State private var detent: PresentationDetent = .large
    @State private var tab = 0
    @State private var path: [ProjectFileRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if review.projectId != nil {
                    PillSegments(titles: ["Modified", "All Files"], selection: $tab)
                        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 10)
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                }
                if tab == 0 {
                    modified
                } else if let projectId = review.projectId {
                    ProjectFilesView(projectId: projectId) { path.append(ProjectFileRoute(path: $0)) }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(tab == 0 ? "\(review.files.count) \(review.files.count == 1 ? "file" : "files") changed" : "Files")
                            .font(.system(size: 17, weight: .semibold))
                        if tab == 0 { DiffCounts(added: review.additions, removed: review.deletions) }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if tab == 0 {
                        Button(detent == .large ? "Collapse" : "Expand",
                               systemImage: detent == .large ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") {
                            withAnimation(.smooth) { detent = detent == .large ? .medium : .large }
                        }
                    }
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            .navigationDestination(for: ProjectFileRoute.self) { route in
                if let projectId = review.projectId { FilePreview(projectId: projectId, path: route.path) }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    private var modified: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // A plain stack: lazy stacks re-estimate wrapped row heights.
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(Array(review.files.enumerated()), id: \.offset) { index, file in
                        DiffFileSection(file: file, onOpen: review.projectId == nil ? nil : { path.append(ProjectFileRoute(path: file.path)) })
                            .id(index)
                    }
                    if review.files.isEmpty {
                        Text("This change is no longer available.").foregroundStyle(Color.text2).padding(40)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
            .onAppear {
                if let focus = review.focus, let index = review.files.firstIndex(where: { $0.path == focus }), index > 0 {
                    proxy.scrollTo(index, anchor: .top)
                }
            }
        }
    }
}

struct ProjectFileRoute: Hashable { let path: String }

/// Gray track with a raised white pill on the selection (Codex style).
struct PillSegments: View {
    let titles: [String]
    @Binding var selection: Int
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
                Button {
                    withAnimation(.snappy(duration: 0.25)) { selection = index }
                } label: {
                    Text(title)
                        .font(.system(size: 15, weight: selection == index ? .semibold : .medium))
                        .foregroundStyle(Color.text1)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background {
                            if selection == index {
                                Capsule().fill(Color.cell)
                                    .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(Color.fill2, in: .capsule)
    }
}

private struct DiffFileSection: View {
    let file: DiffFile
    let onOpen: (() -> Void)?
    @State private var collapsed: Set<Int> = []

    private var name: String { (file.path as NSString).lastPathComponent }
    private var directory: String { (file.path as NSString).deletingLastPathComponent }

    var body: some View {
        let hunks = DiffHunk.split(file)
        let language = SyntaxHighlight.language(for: file.path)
        let digits = String(file.lines.compactMap { $0.newNo }.max() ?? 0).count
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    if !directory.isEmpty {
                        Text(directory).font(.system(size: 12.5)).foregroundStyle(Color.text2).lineLimit(1).truncationMode(.head)
                    }
                }
                Spacer(minLength: 8)
                DiffCounts(added: file.additions, removed: file.deletions)
                if let onOpen {
                    Button(action: onOpen) {
                        Image(systemName: "arrow.up.right.square").font(.system(size: 16, weight: .medium)).foregroundStyle(Color.text1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(name)")
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Color.fill2)

            ForEach(hunks) { hunk in
                let open = !collapsed.contains(hunk.id)
                Button {
                    withAnimation(.snappy(duration: 0.2)) {
                        if open { collapsed.insert(hunk.id) } else { collapsed.remove(hunk.id) }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                            .rotationEffect(.degrees(open ? 0 : -90))
                        Text(hunk.range)
                        Spacer()
                        DiffCounts(added: hunk.additions, removed: hunk.deletions)
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(Color.text2)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.page)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .overlay(alignment: .top) { Rectangle().fill(Color.hair).frame(height: 0.5) }
                .overlay(alignment: .bottom) { Rectangle().fill(Color.hair).frame(height: 0.5) }
                if open {
                    VStack(spacing: 0) {
                        ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                            CodeRow(number: line.type == "del" ? "−" : line.newNo.map(String.init) ?? "",
                                    text: line.text, kind: line.type, language: language, digits: digits)
                        }
                    }
                }
            }
        }
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.hair, lineWidth: 0.5))
    }
}

/// One wrapped code line with its gutter. `kind`: add, del or ctx.
struct CodeRow: View {
    let number: String
    let text: String
    let kind: String
    let language: SyntaxHighlight.Language
    let digits: Int

    var body: some View {
        let added = kind == "add", removed = kind == "del"
        HStack(alignment: .top, spacing: 0) {
            Text(number)
                .foregroundStyle(added ? Color.add : removed ? Color.del : Color.text3)
                .padding(.leading, 10)
                .frame(width: CGFloat(max(digits, 2)) * 8.5 + 22, alignment: .leading)
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.vertical, 3)
                .background(added ? Color.addGutter : removed ? Color.delGutter : Color.fill2)
            Text(SyntaxHighlight.line(text.isEmpty ? " " : text, language))
                .foregroundStyle(Color.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 10).padding(.trailing, 10).padding(.vertical, 3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 13, design: .monospaced))
        .lineSpacing(2)
        .background(added ? Color.addBg : removed ? Color.delBg : Color.page)
        .textSelection(.enabled)
    }
}

// MARK: - All Files

/// The project tree: folders first, expanded in place; search at the bottom.
private struct ProjectFilesView: View {
    @Environment(AppModel.self) private var model
    let projectId: String
    let onOpen: (String) -> Void

    @State private var children: [String: [RemoteFileEntry]] = [:]
    @State private var expanded: Set<String> = []
    @State private var loading: Set<String> = []
    @State private var query = ""
    @State private var results: [RemoteFileEntry]?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if let results {
                    ForEach(results) { entry in
                        row(entry, depth: 0, showPath: true)
                    }
                    if results.isEmpty {
                        Text("No matching files.").foregroundStyle(Color.text2).padding(30)
                    }
                } else {
                    tree("", depth: 0)
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(Color.danger).padding(20) }
                }
            }
            .padding(.bottom, 80)
        }
        .scrollDismissesKeyboard(.immediately)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.text2)
                TextField("Search files", text: $query).submitLabel(.search)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.text3) }
                        .buttonStyle(.plain)
                }
            }
            .font(.system(size: 17))
            .padding(.horizontal, 18).frame(height: 50)
            .glassEffect(.regular.interactive(), in: .capsule)
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
        .task { await load("") }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { results = nil; return }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            results = (try? await model.client.searchFiles(projectId: projectId, query: q)) ?? []
        }
    }

    private func load(_ dir: String) async {
        guard children[dir] == nil, !loading.contains(dir) else { return }
        loading.insert(dir)
        defer { loading.remove(dir) }
        do {
            children[dir] = try await model.client.listFiles(projectId: projectId, path: dir)
        } catch {
            if dir.isEmpty { self.error = "Couldn’t load files from your Mac." }
        }
    }

    private func tree(_ dir: String, depth: Int) -> AnyView {
        AnyView(ForEach(children[dir] ?? []) { entry in
            row(entry, depth: depth, showPath: false)
            if entry.kind == .dir, expanded.contains(entry.path) { tree(entry.path, depth: depth + 1) }
        })
    }

    private func row(_ entry: RemoteFileEntry, depth: Int, showPath: Bool) -> some View {
        let isDir = entry.kind == .dir
        let open = expanded.contains(entry.path)
        return Button {
            if isDir {
                withAnimation(.snappy(duration: 0.2)) {
                    if open { expanded.remove(entry.path) } else { expanded.insert(entry.path) }
                }
                Task { await load(entry.path) }
            } else {
                onOpen(entry.path)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.text3)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .opacity(isDir ? 1 : 0)
                    .frame(width: 12)
                Image(systemName: isDir ? "folder" : "doc.text").font(.system(size: 17)).foregroundStyle(Color.text1).frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.name).font(.system(size: 17)).lineLimit(1)
                    if showPath, entry.path.contains("/") {
                        Text((entry.path as NSString).deletingLastPathComponent).font(.system(size: 12)).foregroundStyle(Color.text2).lineLimit(1).truncationMode(.head)
                    }
                }
                Spacer(minLength: 4)
                if loading.contains(entry.path) { ProgressView().controlSize(.mini) }
            }
            .foregroundStyle(Color.text1)
            .padding(.leading, 18 + CGFloat(depth) * 20).padding(.trailing, 16)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hair).frame(height: 0.5).padding(.leading, 70 + CGFloat(depth) * 20)
        }
    }
}

/// Read-only file contents with line numbers and highlighting.
private struct FilePreview: View {
    @Environment(AppModel.self) private var model
    let projectId: String
    let path: String
    @State private var content: RemoteFileContent?
    @State private var error: String?

    var body: some View {
        Group {
            if let content, let text = content.text {
                let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
                let language = SyntaxHighlight.language(for: content.path)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            CodeRow(number: String(index + 1), text: line, kind: "ctx", language: language, digits: String(lines.count).count)
                        }
                        if content.truncated {
                            Text("Showing the first 512 KB.").font(.system(size: 12)).foregroundStyle(Color.text2).padding(14)
                        }
                    }
                    .padding(.bottom, 24)
                }
            } else if content != nil {
                ContentUnavailableView("Binary file", systemImage: "doc", description: Text("This file can’t be previewed."))
            } else if let error {
                ContentUnavailableView("Couldn’t open file", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { content = try await model.client.readFile(projectId: projectId, path: path) } catch {
                self.error = error.localizedDescription == "NOT_FOUND" ? "The file no longer exists." : error.localizedDescription
            }
        }
    }
}

extension Color {
    private static func gutter(_ light: UInt32, _ dark: UInt32, _ alpha: (CGFloat, CGFloat)) -> Color {
        func ui(_ hex: UInt32, _ a: CGFloat) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark, alpha.1) : ui(light, alpha.0) })
    }
    /// Gutter tints, one step stronger than the row backgrounds.
    static let addGutter = gutter(0x22a05a, 0x2ea043, (0.26, 0.38))
    static let delGutter = gutter(0xdc3232, 0xf85149, (0.2, 0.34))
}
