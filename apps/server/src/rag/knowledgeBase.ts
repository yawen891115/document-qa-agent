import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { log } from "../logger.js";
import type { DocumentKind, DocumentRecord } from "../types.js";
import { findHeadings, loadFile } from "./loaders.js";
import type { LocalVectorStore } from "./vectorStore.js";

export type { DocumentRecord };

export interface KnowledgeBaseOptions {
  chunkSize: number;
  chunkOverlap: number;
  registryFile?: string;
}

/**
 * Ingestion side of the RAG pipeline: load -> split -> embed -> store,
 * plus a small registry of ingested documents.
 */
export class KnowledgeBase {
  private records = new Map<string, DocumentRecord>();
  private registryWrite: Promise<void> = Promise.resolve();

  constructor(
    readonly store: LocalVectorStore,
    private readonly embeddings: EmbeddingsInterface,
    private readonly options: KnowledgeBaseOptions,
  ) {}

  list(): DocumentRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get chunkCount(): number {
    return this.store.size;
  }

  async load(): Promise<void> {
    const compatible = await this.store.load();
    if (this.options.registryFile) {
      try {
        const saved = JSON.parse(await readFile(this.options.registryFile, "utf8")) as DocumentRecord[];
        this.records = new Map(saved.map((r) => [r.id, r]));
      } catch {
        this.records.clear();
      }
    }
    if (!compatible || this.store.size === 0) {
      if (!compatible) {
        log.warn("Vector index was built with a different embedding model; it was cleared. Re-ingest your documents.");
        await this.store.clear();
      }
      if (this.records.size > 0) {
        this.records.clear();
        await this.saveRegistry();
      }
    }
  }

  /** Ingests one file. Identical content (same SHA-256) is only indexed once. */
  async ingest(buffer: Buffer, filename: string): Promise<{ record: DocumentRecord; duplicate: boolean }> {
    const id = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const existing = this.records.get(id);
    if (existing) return { record: existing, duplicate: true };

    const started = performance.now();
    const { kind, pages } = await loadFile(buffer, filename);
    const chunks = await this.split(pages, kind, filename, id);
    if (chunks.length === 0) throw new Error(`No text could be extracted from ${filename}`);

    // "Contextual chunk headers": embed each chunk together with its document name and
    // section title, so a chunk like "16 weeks, in up to two blocks" still matches
    // a query about "parental leave". The stored text stays the raw chunk.
    const texts = chunks.map((c) => `${filename}${c.metadata.section ? ` > ${c.metadata.section}` : ""}\n\n${c.pageContent}`);
    const vectors = await this.embeddings.embedDocuments(texts);
    await this.store.addVectors(vectors, chunks, { ids: chunks.map((_, i) => `${id}:${i}`) });

    const record: DocumentRecord = {
      id,
      name: filename,
      kind,
      sizeBytes: buffer.length,
      pages: kind === "pdf" ? Math.max(...pages.map((p) => Number(p.metadata.page))) : undefined,
      chunks: chunks.length,
      createdAt: new Date().toISOString(),
    };
    this.records.set(id, record);
    await this.saveRegistry();
    log.info(`Ingested ${filename}`, { chunks: chunks.length, ms: Math.round(performance.now() - started) });
    return { record, duplicate: false };
  }

  async remove(id: string): Promise<boolean> {
    if (!this.records.delete(id)) return false;
    await this.store.delete({ where: { documentId: id } });
    await this.saveRegistry();
    return true;
  }

  private async split(pages: Document[], kind: DocumentKind, filename: string, documentId: string): Promise<Document[]> {
    const params = { chunkSize: this.options.chunkSize, chunkOverlap: this.options.chunkOverlap };
    const splitter =
      kind === "markdown"
        ? RecursiveCharacterTextSplitter.fromLanguage("markdown", params)
        : new RecursiveCharacterTextSplitter({ ...params, separators: ["\n\n", "\n", ". ", " ", ""] });

    // Structure-aware chunking: cut at section headings first, then by size, so a chunk
    // never mixes two sections and its section label is exact.
    const out: Document[] = [];
    let carriedSection: string | undefined; // a section can continue onto the next PDF page
    for (const page of pages) {
      const segments = splitBySections(page.pageContent, findHeadings(page.pageContent, kind), carriedSection);
      for (const segment of segments) {
        for (const piece of await splitter.splitText(segment.text)) {
          out.push(
            new Document({
              pageContent: piece,
              metadata: { ...page.metadata, documentId, documentName: filename, section: segment.section, chunkIndex: out.length },
            }),
          );
        }
      }
      carriedSection = segments.at(-1)?.section ?? carriedSection;
    }
    return out;
  }

  /** Serialized, atomic writes (temp file + rename). */
  private saveRegistry(): Promise<void> {
    const file = this.options.registryFile;
    if (!file) return Promise.resolve();
    this.registryWrite = this.registryWrite.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.list(), null, 2));
      await rename(tmp, file);
    });
    return this.registryWrite;
  }
}

const MIN_SECTION_CHARS = 300;

/**
 * Cuts text at heading lines. Text before the first heading keeps the section
 * carried over from the previous page. Very short sections (a heading with one
 * line under it) are merged into the next one so chunks are not too small.
 */
export function splitBySections(
  text: string,
  headings: [number, string][],
  carriedSection?: string,
): { section?: string; text: string }[] {
  const lines = text.split("\n");
  const segments: { section?: string; text: string }[] = [];
  let current = { section: carriedSection, from: 0 };
  for (const [lineNumber, title] of headings) {
    const idx = lineNumber - 1;
    if (idx > current.from) segments.push({ section: current.section, text: lines.slice(current.from, idx).join("\n") });
    current = { section: title, from: idx };
  }
  segments.push({ section: current.section, text: lines.slice(current.from).join("\n") });

  const merged: { section?: string; text: string }[] = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const prev = merged.at(-1);
    if (prev && prev.text.trim().length < MIN_SECTION_CHARS) {
      // The merged chunk is labeled with whichever part is longer.
      if (segment.text.length > prev.text.length) prev.section = segment.section;
      prev.text = `${prev.text}\n${segment.text}`;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}
