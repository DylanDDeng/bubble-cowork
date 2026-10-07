import SwiftUI

/// Chat Markdown without dependencies: Foundation parses GitHub-flavored
/// Markdown into an AttributedString; its block intents become SwiftUI views.
struct MarkdownView: View {
    let text: String
    var streaming = false
    var font: Font = .app(15)

    var body: some View {
        let blocks = MarkdownBlocks.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                BlockView(block: block, font: font, trailingDot: streaming && index == blocks.count - 1)
            }
            if blocks.isEmpty && streaming { StreamDot() }
        }
        .tint(Color.text1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StreamDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Color.text1).frame(width: 8, height: 8)
            .opacity(on ? 1 : 0.3)
            .onAppear { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { on = true } }
    }
}

indirect enum MarkdownBlock {
    case paragraph(AttributedString)
    case heading(Int, AttributedString)
    case code(String, language: String?)
    case list(ordered: Bool, items: [(marker: String, blocks: [MarkdownBlock])])
    case quote([MarkdownBlock])
    case table(header: [AttributedString], rows: [[AttributedString]])
    case rule
}

enum MarkdownBlocks {
    private static var cache: [String: [MarkdownBlock]] = [:]

    static func parse(_ text: String) -> [MarkdownBlock] {
        if let hit = cache[text] { return hit }
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard let attributed = try? AttributedString(markdown: text, options: options) else {
            return [.paragraph(AttributedString(text))]
        }
        // Each run carries its block path (innermost first); keep runs with the full path.
        var runs: [(path: [PresentationIntent.IntentType], text: AttributedString)] = []
        for run in attributed.runs {
            let path = run.presentationIntent?.components ?? []
            let piece = AttributedString(attributed[run.range])
            if let last = runs.last, last.path == path {
                runs[runs.count - 1].text += piece
            } else {
                runs.append((path, piece))
            }
        }
        let blocks = build(runs.map { ($0.path.reversed(), $0.text) })
        if cache.count > 400 { cache.removeAll() }
        cache[text] = blocks
        return blocks
    }

    /// Builds blocks from runs whose paths are outermost-first.
    private static func build(_ runs: [(path: [PresentationIntent.IntentType], text: AttributedString)]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < runs.count {
            guard let head = runs[i].path.first else {
                blocks.append(.paragraph(trimmed(runs[i].text)))
                i += 1
                continue
            }
            // All following runs inside the same outermost block.
            var j = i
            while j < runs.count, runs[j].path.first == head { j += 1 }
            let group = Array(runs[i..<j])
            let inner = group.map { (Array($0.path.dropFirst()), $0.text) }
            switch head.kind {
            case .paragraph:
                blocks.append(.paragraph(trimmed(join(group.map(\.text)))))
            case .header(let level):
                blocks.append(.heading(level, trimmed(join(group.map(\.text)))))
            case .codeBlock(let language):
                var code = String(join(group.map(\.text)).characters)
                if code.hasSuffix("\n") { code.removeLast() }
                blocks.append(.code(code, language: language))
            case .thematicBreak:
                blocks.append(.rule)
            case .blockQuote:
                blocks.append(.quote(build(inner)))
            case .orderedList, .unorderedList:
                let ordered: Bool = { if case .orderedList = head.kind { return true }; return false }()
                var items: [(String, [MarkdownBlock])] = []
                var k = 0
                while k < inner.count {
                    guard let itemIntent = inner[k].0.first else { k += 1; continue }
                    var l = k
                    while l < inner.count, inner[l].0.first == itemIntent { l += 1 }
                    var marker = "•"
                    if case .listItem(let ordinal) = itemIntent.kind, ordered { marker = "\(ordinal)." }
                    items.append((marker, build(inner[k..<l].map { (Array($0.0.dropFirst()), $0.1) })))
                    k = l
                }
                blocks.append(.list(ordered: ordered, items: items))
            case .table:
                var header: [AttributedString] = []
                var rows: [[AttributedString]] = []
                var current: [AttributedString] = []
                var currentRow: PresentationIntent.IntentType?
                var isHeader = false
                for (path, text) in inner {
                    guard let rowIntent = path.first else { continue }
                    if rowIntent != currentRow {
                        if currentRow != nil { if isHeader { header = current } else { rows.append(current) } }
                        current = []
                        currentRow = rowIntent
                        if case .tableHeaderRow = rowIntent.kind { isHeader = true } else { isHeader = false }
                    }
                    // Cells are the next level; consecutive runs in one cell are joined.
                    if let cell = path.dropFirst().first, case .tableCell(let column) = cell.kind {
                        while current.count <= column { current.append(AttributedString()) }
                        current[column] += text
                    }
                }
                if currentRow != nil { if isHeader { header = current } else { rows.append(current) } }
                blocks.append(.table(header: header, rows: rows))
            default:
                blocks.append(contentsOf: build(inner))
            }
            i = j
        }
        return blocks
    }

    private static func join(_ parts: [AttributedString]) -> AttributedString {
        parts.reduce(into: AttributedString()) { $0 += $1 }
    }

    private static func trimmed(_ text: AttributedString) -> AttributedString {
        var text = text
        while let last = text.characters.last, last.isNewline { text.characters.removeLast() }
        return text
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    let font: Font
    var trailingDot = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch block {
        case .paragraph(let text):
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text(styled(text)).font(font).lineSpacing(3.5).textSelection(.enabled)
                if trailingDot { StreamDot() }
            }
        case .heading(let level, let text):
            Text(styled(text))
                .font(.app([20, 18, 17, 15, 15, 15][min(max(level - 1, 0), 5)], weight: .semibold))
                .padding(.top, 6)
        case .code(let code, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.app(13, design: .monospaced)).lineSpacing(3).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 12)
            }
            .background(Color.code, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.hair, lineWidth: 0.5))
        case .list(_, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.marker).font(font).foregroundStyle(Color.text2).frame(minWidth: 14, alignment: .trailing)
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { _, inner in BlockView(block: inner, font: font) }
                        }
                    }
                }
            }
        case .quote(let blocks):
            HStack(spacing: 10) {
                Rectangle().fill(Color.hair).frame(width: 2)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in BlockView(block: inner, font: font) }
                }
                .foregroundStyle(Color.text2)
            }
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    if !header.isEmpty {
                        GridRow { ForEach(Array(header.enumerated()), id: \.offset) { cell($0.element, bold: true) } }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { cell($0.element, bold: false) } }
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.hair, lineWidth: 0.5))
            }
        case .rule:
            Rectangle().fill(Color.hair).frame(height: 0.5).padding(.vertical, 6)
        }
    }

    private func cell(_ text: AttributedString, bold: Bool) -> some View {
        Text(styled(text))
            .font(.app(14, weight: bold ? .semibold : .regular))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: 260, alignment: .leading)
            .overlay(Rectangle().strokeBorder(Color.hair, lineWidth: 0.25))
    }

    /// Inline code gets a chip background; links are underlined.
    private func styled(_ text: AttributedString) -> AttributedString {
        var text = text
        for run in text.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                text[run.range].font = .app(14, design: .monospaced)
                text[run.range].backgroundColor = Color.fill2
            }
            if run.link != nil {
                text[run.range].underlineStyle = .single
            }
        }
        return text
    }
}
