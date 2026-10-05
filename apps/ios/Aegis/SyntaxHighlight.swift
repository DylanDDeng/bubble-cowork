import SwiftUI

/// Small per-line highlighter for diffs and file previews: comments, strings,
/// numbers, keywords, and object keys in JS-family files. Not a parser; it
/// only colors what a reader scans for.
enum SyntaxHighlight {
    enum Language { case cLike, js, python, shell, markup, css, plain }

    static func language(for path: String) -> Language {
        switch (path as NSString).pathExtension.lowercased() {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "json": return .js
        case "swift", "c", "h", "m", "mm", "cpp", "cc", "java", "kt", "go", "rs", "cs", "dart", "scala": return .cLike
        case "py", "rb", "yml", "yaml", "toml": return .python
        case "sh", "bash", "zsh", "fish", "env": return .shell
        case "html", "htm", "xml", "plist", "svg", "vue": return .markup
        case "css", "scss", "less": return .css
        default: return .plain
        }
    }

    private static let keywords: Set<String> = [
        "import", "from", "export", "default", "as", "func", "function", "let", "var", "const", "if", "else",
        "return", "guard", "class", "struct", "enum", "interface", "type", "true", "false", "nil", "null",
        "undefined", "await", "async", "for", "while", "in", "of", "switch", "case", "break", "continue", "new",
        "this", "self", "Self", "try", "catch", "throw", "throws", "public", "private", "fileprivate", "internal",
        "static", "void", "extends", "implements", "protocol", "extension", "where", "override", "init", "deinit",
        "typeof", "instanceof", "yield", "do", "def", "elif", "lambda", "pass", "None", "True", "False", "with",
        "fn", "pub", "mut", "impl", "use", "mod", "match", "package", "final", "super", "readonly", "some", "any",
        "inout", "defer", "repeat", "is", "not", "and", "or", "echo", "then", "fi", "export", "local",
    ]

    static func line(_ text: String, _ language: Language) -> AttributedString {
        var out = AttributedString()
        func add(_ s: Substring, _ color: Color? = nil) {
            var piece = AttributedString(String(s))
            if let color { piece.foregroundColor = color }
            out += piece
        }
        guard language != .plain else { return AttributedString(text) }
        let chars = Array(text)
        var i = 0
        var plainStart = 0
        func flushPlain(to end: Int) {
            if plainStart < end { add(Substring(String(chars[plainStart..<end]))) }
        }
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            // Comments run to the end of the line.
            let lineComment = (language == .js || language == .cLike || language == .css) && c == "/" && next == "/"
                || (language == .python || language == .shell) && c == "#"
            if lineComment {
                flushPlain(to: i)
                add(Substring(String(chars[i...])), .synComment)
                return out
            }
            if c == "/" && next == "*" || language == .markup && c == "<" && text.dropFirst(i).hasPrefix("<!--") {
                flushPlain(to: i)
                let close = c == "/" ? "*/" : "-->"
                let rest = String(chars[i...])
                let end = rest.range(of: close, range: rest.index(rest.startIndex, offsetBy: 2)..<rest.endIndex).map { rest.distance(from: rest.startIndex, to: $0.upperBound) } ?? rest.count
                add(Substring(String(chars[i..<(i + end)])), .synComment)
                i += end
                plainStart = i
                continue
            }
            if c == "\"" || c == "'" || c == "`" {
                flushPlain(to: i)
                var j = i + 1
                while j < chars.count && chars[j] != c {
                    if chars[j] == "\\" { j += 1 }
                    j += 1
                }
                let end = min(j + 1, chars.count)
                add(Substring(String(chars[i..<end])), .synString)
                i = end
                plainStart = i
                continue
            }
            if c.isASCII, c.isNumber, i == 0 || !(chars[i - 1].isLetter || chars[i - 1] == "_" || chars[i - 1].isNumber) {
                flushPlain(to: i)
                var j = i
                while j < chars.count, chars[j].isASCII, chars[j].isHexDigit || chars[j] == "." || chars[j] == "x" { j += 1 }
                add(Substring(String(chars[i..<j])), .synNumber)
                i = j
                plainStart = i
                continue
            }
            if c.isLetter || c == "_" || c == "$" {
                var j = i
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" || chars[j] == "$" { j += 1 }
                let word = String(chars[i..<j])
                var color: Color?
                if language == .markup, i > 0, chars[i - 1] == "<" || (i > 1 && chars[i - 1] == "/" && chars[i - 2] == "<") {
                    color = .synKeyword
                } else if language != .markup, keywords.contains(word) {
                    color = .synKeyword
                } else if language == .js || language == .css {
                    // Object keys and CSS properties: an identifier followed by ":".
                    var k = j
                    while k < chars.count, chars[k] == " " { k += 1 }
                    if k < chars.count, chars[k] == ":", !(k + 1 < chars.count && chars[k + 1] == ":") { color = .synKey }
                }
                if let color {
                    flushPlain(to: i)
                    add(Substring(word), color)
                    plainStart = j
                }
                i = j
                continue
            }
            i += 1
        }
        flushPlain(to: chars.count)
        return out
    }
}

extension Color {
    private static func syn(_ light: UInt32, _ dark: UInt32) -> Color {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }
    // Xcode-like palette, as in the Codex mobile diff view.
    static let synKeyword = syn(0xad3da4, 0xfc5fa3)
    static let synString = syn(0xc41a16, 0xfc6a5d)
    static let synNumber = syn(0x1c00cf, 0xd0bf69)
    static let synComment = syn(0x267507, 0x7ec16e)
    static let synKey = syn(0x9c5b00, 0xe6a05c)
}
