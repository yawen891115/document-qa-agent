import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HashingEmbeddings } from "../src/llm/offline.js";
import { KnowledgeBase, splitBySections } from "../src/rag/knowledgeBase.js";
import { findHeadings, loadFile, removeRepeatedLines, UnsupportedFileError } from "../src/rag/loaders.js";
import { LocalVectorStore } from "../src/rag/vectorStore.js";
import { SAMPLES_DIR, testConfig } from "./helpers.js";

const sample = (name: string) => readFile(join(SAMPLES_DIR, name));

function newKb(dir?: string, embeddingModel?: string) {
  const embeddings = new HashingEmbeddings();
  const store = new LocalVectorStore(embeddings, {
    file: dir ? `${dir}/vectors.json` : undefined,
    embeddingModel: embeddingModel ?? embeddings.modelName,
  });
  const kb = new KnowledgeBase(store, embeddings, {
    chunkSize: 1000,
    chunkOverlap: 150,
    registryFile: dir ? `${dir}/documents.json` : undefined,
  });
  return kb;
}

describe("loaders", () => {
  it("reads a PDF page by page and strips running headers/footers", async () => {
    const { kind, pages } = await loadFile(await sample("northwind-employee-handbook.pdf"), "handbook.pdf");
    expect(kind).toBe("pdf");
    expect(pages.map((p) => p.metadata.page)).toEqual([1, 2, 3, 4]);
    const page2 = pages[1]!.pageContent;
    expect(page2).toContain("Tuesday, Wednesday and Thursday");
    expect(page2).not.toMatch(/Employee Handbook \(2026 edition\)/); // running header removed
    expect(page2).not.toMatch(/Page 2/); // footer removed
  });

  it("reads DOCX, reStructuredText and Markdown", async () => {
    const docx = await loadFile(await sample("northwind-security-policy.docx"), "policy.docx");
    expect(docx.pages[0]!.pageContent).toContain("at least 14 characters");
    const rst = await loadFile(await sample("pep-0008-style-guide.rst"), "pep8.rst");
    expect(rst.kind).toBe("rst");
    const md = await loadFile(Buffer.from("# Title\n\nBody"), "notes.md");
    expect(md.kind).toBe("markdown");
  });

  it("rejects unsupported file types", async () => {
    await expect(loadFile(Buffer.from("x"), "image.png")).rejects.toThrow(UnsupportedFileError);
  });

  it("finds headings in each format", () => {
    expect(findHeadings("intro\n## Transports\ntext", "markdown")).toEqual([[2, "Transports"]]);
    expect(findHeadings("Code Lay-out\n============\ntext", "rst")).toEqual([[1, "Code Lay-out"]]);
    expect(findHeadings("3. Paid Time Off (PTO)\nPTO accrues...\n2 paid days for an extended family member.", "pdf")).toEqual([
      [1, "3. Paid Time Off (PTO)"],
    ]);
  });

  it("only removes lines that repeat on most pages", () => {
    const pages = ["Header\nPage 1\nalpha", "Header\nPage 2\nbeta", "Header\nPage 3\ngamma"];
    expect(removeRepeatedLines(pages)).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("splitBySections", () => {
  it("cuts at headings and carries the previous section", () => {
    const long = "x".repeat(400);
    const segments = splitBySections(`${long}\n## A\n${long}\n## B\n${long}`, [[2, "A"], [4, "B"]], "Carried");
    expect(segments.map((s) => s.section)).toEqual(["Carried", "A", "B"]);
  });

  it("merges tiny sections into the next one, labeled by the longer part", () => {
    const segments = splitBySections(`## A\nshort\n## B\n${"y".repeat(500)}`, [[1, "A"], [3, "B"]]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.section).toBe("B");
  });
});

describe("KnowledgeBase", () => {
  it("ingests documents with page and section metadata, and retrieves them", async () => {
    const kb = newKb();
    const { record } = await kb.ingest(await sample("northwind-employee-handbook.pdf"), "handbook.pdf");
    expect(record.pages).toBe(4);
    expect(record.chunks).toBeGreaterThan(3);

    const q = await kb.store.embeddings.embedQuery("How long is paid parental leave?");
    const [[doc, score]] = (await kb.store.similaritySearchVectorWithScore(q, 1)) as [[{ pageContent: string; metadata: Record<string, unknown> }, number]];
    expect(doc.pageContent).toContain("16 weeks");
    expect(doc.metadata).toMatchObject({ documentName: "handbook.pdf", page: 3, section: "4. Leave Programs" });
    expect(score).toBeGreaterThan(0.2);
  });

  it("indexes identical content only once", async () => {
    const kb = newKb();
    const buf = Buffer.from("Northwind offers 18 days of PTO.");
    const first = await kb.ingest(buf, "a.txt");
    const second = await kb.ingest(buf, "copy-of-a.txt");
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(kb.list()).toHaveLength(1);
  });

  it("removes a document and its chunks", async () => {
    const kb = newKb();
    const a = await kb.ingest(Buffer.from("Alpha document about PTO."), "a.txt");
    await kb.ingest(Buffer.from("Beta document about travel."), "b.txt");
    const before = kb.chunkCount;
    expect(await kb.remove(a.record.id)).toBe(true);
    expect(kb.chunkCount).toBe(before - a.record.chunks);
    expect(await kb.remove("missing")).toBe(false);
  });

  it("persists to disk and reloads", async () => {
    const dir = testConfig().paths.indexDir;
    const kb = newKb(dir);
    await kb.ingest(await sample("northwind-security-policy.docx"), "policy.docx");

    const reloaded = newKb(dir);
    await reloaded.load();
    expect(reloaded.list().map((d) => d.name)).toEqual(["policy.docx"]);
    expect(reloaded.chunkCount).toBe(kb.chunkCount);
  });

  it("clears an index built with a different embedding model", async () => {
    const dir = testConfig().paths.indexDir;
    await newKb(dir).ingest(Buffer.from("Some text about expenses."), "x.txt");

    const other = newKb(dir, "text-embedding-3-small");
    await other.load();
    expect(other.chunkCount).toBe(0);
    expect(other.list()).toEqual([]);
  });
});
