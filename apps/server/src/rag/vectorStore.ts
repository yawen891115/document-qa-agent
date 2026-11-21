import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";

interface Entry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  vector: Float32Array; // L2-normalized, so cosine similarity is a dot product
}

interface PersistedIndex {
  version: 1;
  embeddingModel: string;
  dims: number;
  entries: { id: string; content: string; metadata: Record<string, unknown>; vector: string }[];
}

/**
 * A small LangChain VectorStore: exact cosine search over normalized vectors,
 * persisted to one JSON file (vectors stored as base64 Float32).
 *
 * Exact search over a few thousand chunks takes a few milliseconds, which is
 * cheaper than a network hop to a vector DB. Because it implements LangChain's
 * VectorStore interface, swapping in pgvector, Chroma or Pinecone is a
 * one-line change in services.ts.
 */
export class LocalVectorStore extends VectorStore {
  declare FilterType: (doc: DocumentInterface) => boolean;

  private entries: Entry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    embeddings: EmbeddingsInterface,
    private readonly options: { file?: string; embeddingModel: string },
  ) {
    super(embeddings, {});
  }

  _vectorstoreType(): string {
    return "local-json";
  }

  get size(): number {
    return this.entries.length;
  }

  async addDocuments(documents: DocumentInterface[], options?: { ids?: string[] }): Promise<string[]> {
    const vectors = await this.embeddings.embedDocuments(documents.map((d) => d.pageContent));
    return this.addVectors(vectors, documents, options);
  }

  async addVectors(vectors: number[][], documents: DocumentInterface[], options?: { ids?: string[] }): Promise<string[]> {
    if (vectors.length !== documents.length) throw new Error("vectors and documents must have the same length");
    const ids = documents.map((_, i) => options?.ids?.[i] ?? randomUUID());
    documents.forEach((doc, i) => {
      this.entries.push({ id: ids[i]!, content: doc.pageContent, metadata: { ...doc.metadata }, vector: normalize(vectors[i]!) });
    });
    await this.save();
    return ids;
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: this["FilterType"],
  ): Promise<[DocumentInterface, number][]> {
    const q = normalize(query);
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of this.entries) {
      if (entry.vector.length !== q.length) continue;
      const doc = new Document({ pageContent: entry.content, metadata: entry.metadata, id: entry.id });
      if (filter && !filter(doc)) continue;
      scored.push({ entry, score: dot(q, entry.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, k)
      .map(({ entry, score }) => [new Document({ pageContent: entry.content, metadata: entry.metadata, id: entry.id }), score]);
  }

  /** Delete by chunk ids, or every chunk whose metadata matches `where`. */
  override async delete(params: { ids?: string[]; where?: Record<string, unknown> } = {}): Promise<void> {
    const ids = new Set(params.ids ?? []);
    const where = params.where ? Object.entries(params.where) : [];
    this.entries = this.entries.filter(
      (e) => !(ids.has(e.id) || (where.length > 0 && where.every(([key, value]) => e.metadata[key] === value))),
    );
    await this.save();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }

  /**
   * Loads the index from disk. Returns false (and starts empty) if the index was
   * built with a different embedding model, since its vectors are not comparable.
   */
  async load(): Promise<boolean> {
    if (!this.options.file) return true;
    let raw: string;
    try {
      raw = await readFile(this.options.file, "utf8");
    } catch {
      return true; // no index yet
    }
    const data = JSON.parse(raw) as PersistedIndex;
    if (data.embeddingModel !== this.options.embeddingModel) {
      this.entries = [];
      return false;
    }
    this.entries = data.entries.map((e) => ({
      id: e.id,
      content: e.content,
      metadata: e.metadata,
      vector: new Float32Array(new Uint8Array(Buffer.from(e.vector, "base64")).buffer),
    }));
    return true;
  }

  /** Writes are serialized and atomic (temp file + rename). */
  private save(): Promise<void> {
    const file = this.options.file;
    if (!file) return Promise.resolve();
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.entries.length === 0) {
        await rm(file, { force: true });
        return;
      }
      const data: PersistedIndex = {
        version: 1,
        embeddingModel: this.options.embeddingModel,
        dims: this.entries[0]?.vector.length ?? 0,
        entries: this.entries.map((e) => ({
          id: e.id,
          content: e.content,
          metadata: e.metadata,
          vector: Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength).toString("base64"),
        })),
      };
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    });
    return this.writeQueue;
  }
}

function normalize(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
