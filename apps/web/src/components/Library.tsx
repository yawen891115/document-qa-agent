import { FileText, Trash2, Upload } from "lucide-react";
import { useState, type DragEvent } from "react";
import type { DocumentKind, DocumentRecord } from "../types";

const KIND_LABEL: Record<DocumentKind, string> = {
  pdf: "PDF",
  docx: "Word",
  markdown: "Markdown",
  rst: "reStructuredText",
  text: "Text",
};

const ACCEPT = ".pdf,.docx,.md,.markdown,.mdx,.rst,.txt";

interface Props {
  /** Small screens: the library is a panel toggled from the header. */
  open: boolean;
  documents: DocumentRecord[];
  chunks: number;
  working: string | null;
  error: string | null;
  onUpload: (files: File[]) => void;
  onLoadSamples: () => void;
  onRemove: (doc: DocumentRecord) => void;
  onDismissError: () => void;
}

export function Library({ open, documents, chunks, working, error, onUpload, onLoadSamples, onRemove, onDismissError }: Props) {
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onUpload(files);
  };

  return (
    <aside id="library" className={`library${open ? " is-open" : ""}`} aria-labelledby="library-title">
      <h2 id="library-title">Library</h2>
      <p className="library-summary">
        {documents.length === 0
          ? "No documents yet."
          : `${documents.length} ${documents.length === 1 ? "document" : "documents"}, ${chunks} passages indexed`}
      </p>

      <label
        className={`dropzone${dragging ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          disabled={Boolean(working)}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onUpload(files);
            e.target.value = "";
          }}
        />
        <Upload size={18} aria-hidden="true" />
        <span>
          <strong>Add files</strong> or drop them here
          <small>PDF, Word, Markdown, reStructuredText or plain text, up to 20 MB</small>
        </span>
      </label>

      {working && (
        <p className="library-status" role="status">
          {working}
        </p>
      )}
      {error && (
        <p className="library-error" role="alert">
          {error}{" "}
          <button type="button" className="link-button" onClick={onDismissError}>
            Dismiss
          </button>
        </p>
      )}

      {documents.length === 0 ? (
        <div className="library-empty">
          <p>Try the sample set: a fictional company handbook and security policy, the PEP 8 style guide and the MCP specification.</p>
          <button type="button" className="button button--quiet" onClick={onLoadSamples} disabled={Boolean(working)}>
            Load sample documents
          </button>
        </div>
      ) : (
        <ul className="doc-list">
          {documents.map((doc) => (
            <li key={doc.id} className="doc">
              <FileText size={18} className="doc-icon" aria-hidden="true" />
              <div className="doc-text">
                <p className="doc-name">{doc.name}</p>
                <p className="doc-meta">
                  {[KIND_LABEL[doc.kind], doc.pages ? `${doc.pages} pages` : "", `${doc.chunks} passages`].filter(Boolean).join(", ")}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => onRemove(doc)}
                disabled={Boolean(working)}
                aria-label={`Remove ${doc.name}`}
                title="Remove from library"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
