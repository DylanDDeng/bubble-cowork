import { useState, useMemo } from 'react'

interface TextFileReaderProps {
  text: string
  fileName?: string
}

export default function TextFileReader({ text, fileName }: TextFileReaderProps) {
  const [showLineNumbers, setShowLineNumbers] = useState(false)

  const lines = useMemo(() => text.split('\n'), [text])
  const lineCount = lines.length
  // Pad line numbers to the width of the largest line number
  const lineNumWidth = String(lineCount).length

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--preview-surface)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {fileName && (
            <span className="text-xs text-[var(--text-primary)] font-medium truncate">
              {fileName}
            </span>
          )}
          <span className="text-xs text-[var(--text-muted)] shrink-0">
            {lineCount.toLocaleString()} lines
          </span>
        </div>
        <button
          onClick={() => setShowLineNumbers(!showLineNumbers)}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${
            showLineNumbers
              ? 'bg-[var(--accent-light)] text-[var(--accent)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
          }`}
        >
          {showLineNumbers ? 'Hide' : 'Show'} line numbers
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-5">
          <pre className="text-sm leading-relaxed whitespace-pre-wrap break-words font-sans text-[var(--text-primary)] m-0">
            {showLineNumbers ? (
              <table className="border-collapse w-full">
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="group">
                      <td
                        className="align-top pr-4 select-none text-right"
                        style={{ width: `${lineNumWidth + 1}ch` }}
                      >
                        <span className="text-xs text-[var(--text-muted)] opacity-40 group-hover:opacity-70 transition-opacity tabular-nums">
                          {i + 1}
                        </span>
                      </td>
                      <td className="align-top">
                        <span className="text-sm leading-relaxed">{line || '\u00A0'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              lines.map((line, i) => (
                <span key={i}>
                  {line || '\u00A0'}
                  {i < lines.length - 1 ? '\n' : ''}
                </span>
              ))
            )}
          </pre>
        </div>
      </div>
    </div>
  )
}
