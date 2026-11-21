import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import multer from "multer";
import { detectKind } from "../rag/loaders.js";
import type { Services } from "../services.js";

/** Multer reads multipart filenames as latin1; recover UTF-8 names (e.g. Chinese file names). */
export function decodeFilename(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}

export function documentsRouter(s: Services): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ documents: s.kb.list(), chunks: s.kb.chunkCount });
  });

  if (s.config.publicDemo) return router;

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: s.config.maxUploadBytes, files: 10 } });
  router.post("/", upload.array("files", 10), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded. Send multipart/form-data with field 'files'." });
      return;
    }
    const documents = [];
    for (const file of files) {
      const { record, duplicate } = await s.kb.ingest(file.buffer, decodeFilename(file.originalname));
      documents.push({ ...record, duplicate });
    }
    res.status(201).json({ documents });
  });

  /** Ingests the bundled sample documents (data/samples). */
  router.post("/samples", async (_req, res) => {
    const names = (await readdir(s.config.paths.samplesDir)).filter((n) => detectKind(n) && n !== "README.md").sort();
    const documents = [];
    for (const name of names) {
      const { record, duplicate } = await s.kb.ingest(await readFile(join(s.config.paths.samplesDir, name)), name);
      documents.push({ ...record, duplicate });
    }
    res.status(201).json({ documents });
  });

  router.delete("/:id", async (req, res) => {
    const removed = await s.kb.remove(req.params.id);
    if (removed) res.status(204).end();
    else res.status(404).json({ error: "Document not found" });
  });

  return router;
}
