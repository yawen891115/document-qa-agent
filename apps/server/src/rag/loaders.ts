import { extname } from "node:path";
import { Document } from "@langchain/core/documents";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentKind } from "../types.js";

export type { DocumentKind };

const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".rst": "rst",
  ".txt": "text",
};

export const SUPPORTED_EXTENSIONS = Object.keys(KIND_BY_EXTENSION);

export class UnsupportedFileError extends Error {
  constructor(filename: string) {
    super(`Unsupported file type: ${filename}. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`);
    this.name = "UnsupportedFileError";
  }
}

export function detectKind(filename: string): DocumentKind | undefined {
  return KIND_BY_EXTENSION[extname(filename).toLowerCase()];
}

/**
 * Parses a file into LangChain Documents. PDFs yield one Document per page
 * (metadata.page is 1-based) so answers can cite page numbers.
 */
export async function loadFile(buffer: Buffer, filename: string): Promise<{ kind: DocumentKind; pages: Document[] }> {
  const kind = detectKind(filename);
  if (!kind) throw new UnsupportedFileError(filename);

  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = removeRepeatedLines(text.map(cleanPdfText));
    return {
      kind,
      pages: pages
        .map((pageContent, i) => new Document({ pageContent, metadata: { page: i + 1 } }))
        .filter((d) => d.pageContent.trim().length > 0),
    };
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    return { kind, pages: [new Document({ pageContent: value.replace(/\n{3,}/g, "\n\n").trim(), metadata: {} })] };
  }

  return { kind, pages: [new Document({ pageContent: buffer.toString("utf8").replace(/\r\n/g, "\n"), metadata: {} })] };
}

function cleanPdfText(text: string): string {
  return text
    .replace(/([a-z])-\n([a-z])/g, "$1$2") // re-join hyphenated line breaks
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drops running headers/footers: lines that repeat on most pages of a PDF
 * ("Page 3", the document title, ...). Digits are masked so page numbers match.
 */
export function removeRepeatedLines(pages: string[]): string[] {
  if (pages.length < 3) return pages;
  const key = (line: string) => line.trim().replace(/\d+/g, "#");
  const pageCount = new Map<string, number>();
  for (const page of pages) {
    for (const k of new Set(page.split("\n").map(key))) {
      if (k) pageCount.set(k, (pageCount.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(pages.length * 0.6);
  return pages.map((page) =>
    page
      .split("\n")
      .filter((line) => (pageCount.get(key(line)) ?? 0) < threshold)
      .join("\n")
      .trim(),
  );
}

/** Returns [lineNumber (1-based), heading] pairs used to label chunks with their section. */
export function findHeadings(text: string, kind: DocumentKind): [number, string][] {
  const lines = text.split("\n");
  const out: [number, string][] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (kind === "markdown") {
      const m = /^#{1,4}\s+(.+?)\s*#*$/.exec(trimmed);
      if (m) out.push([i + 1, m[1]!]);
    } else if (kind === "rst") {
      const next = lines[i + 1]?.trim() ?? "";
      if (trimmed && /^[A-Za-z]/.test(trimmed) && /^([=\-~^"'`#*+])\1{2,}$/.test(next) && next.length >= trimmed.length - 1) {
        out.push([i + 1, trimmed]);
      }
    } else {
      // Numbered headings such as "3. Paid Time Off (PTO)" in PDFs, DOCX and text files.
      const m = /^(\d{1,2}(?:\.\d{1,2})*\.?)\s+([A-Z][^.!?]{2,60})$/.exec(trimmed);
      if (m) out.push([i + 1, `${m[1]} ${m[2]}`.trim()]);
    }
  });
  return out;
}
