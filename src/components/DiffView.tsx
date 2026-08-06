import { useState } from 'react'
import { FileStatus, LineKind, type FileDiff } from '~/gen/forge/v1/pull_pb'

/**
 * Unified diff renderer.
 *
 * Line numbers live in their own table cells rather than being baked into the
 * text, so selecting a hunk copies the code without the gutter — the thing that
 * makes copying from a diff viewer usually useless.
 */
export function DiffView({ files, truncated }: { files: FileDiff[]; truncated: boolean }) {
  if (files.length === 0) {
    return <p className="muted">No changes.</p>
  }

  return (
    <>
      <div className="diff-summary muted">
        {files.length} changed file{files.length === 1 ? '' : 's'}
        <span className="diff-add"> +{sum(files, (file) => file.additions)}</span>
        <span className="diff-del"> −{sum(files, (file) => file.deletions)}</span>
      </div>

      {truncated && (
        <div className="notice notice-warning">
          This diff was truncated because it exceeded the file limit.
        </div>
      )}

      {files.map((file) => (
        <FileDiffBlock key={file.path} file={file} />
      ))}
    </>
  )
}

function FileDiffBlock({ file }: { file: FileDiff }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section className="diff-file">
      <header className="diff-file-head">
        <button
          type="button"
          className="diff-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <code>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</code>
        <span className={`badge badge-${statusName(file.status)}`}>{statusName(file.status)}</span>
        {!file.isBinary && (
          <span className="muted">
            <span className="diff-add">+{file.additions}</span>{' '}
            <span className="diff-del">−{file.deletions}</span>
          </span>
        )}
      </header>

      {!collapsed && (
        <>
          {file.isBinary && <p className="diff-note muted">Binary file not shown.</p>}
          {file.truncated && (
            <p className="diff-note muted">File is too large to display a diff.</p>
          )}
          {!file.isBinary && !file.truncated && (
            <table className="diff-table">
              <tbody>
                {file.hunks.map((hunk) => (
                  <>
                    <tr key={hunk.header} className="diff-hunk-header">
                      <td colSpan={3}>{hunk.header}</td>
                    </tr>
                    {hunk.lines.map((line, index) => (
                      <tr key={`${hunk.header}-${index}`} className={`diff-${kindName(line.kind)}`}>
                        {/* A zero line number means the line does not exist on
                            that side, so the cell is left blank rather than
                            printing a misleading 0. */}
                        <td className="diff-num">{line.oldLine || ''}</td>
                        <td className="diff-num">{line.newLine || ''}</td>
                        <td className="diff-code">
                          <span className="diff-marker">{marker(line.kind)}</span>
                          {line.content}
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}

function sum(files: FileDiff[], pick: (file: FileDiff) => number): number {
  return files.reduce((total, file) => total + pick(file), 0)
}

function statusName(status: FileStatus): string {
  switch (status) {
    case FileStatus.ADDED:
      return 'added'
    case FileStatus.DELETED:
      return 'deleted'
    case FileStatus.RENAMED:
      return 'renamed'
    default:
      return 'modified'
  }
}

function kindName(kind: LineKind): string {
  return kind === LineKind.ADD ? 'add' : kind === LineKind.DELETE ? 'del' : 'ctx'
}

function marker(kind: LineKind): string {
  return kind === LineKind.ADD ? '+' : kind === LineKind.DELETE ? '-' : ' '
}
