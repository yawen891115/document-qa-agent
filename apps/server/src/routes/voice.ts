import { Router } from "express";
import multer from "multer";
import { toFile } from "openai";
import type { Services } from "../services.js";

/**
 * Server-side speech-to-text. The web UI uses the browser's built-in speech
 * recognition when it exists (Chrome, Edge, Safari) and falls back to this
 * endpoint elsewhere (e.g. Firefox), sending a short recorded clip.
 */
export function voiceRouter(s: Services): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  router.post("/transcribe", upload.single("audio"), async (req, res) => {
    const openai = s.models.openai;
    if (!openai) {
      res.status(503).json({ error: "Server-side transcription needs OPENAI_API_KEY. Chrome, Edge and Safari can transcribe in the browser instead." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No audio uploaded. Send multipart/form-data with field 'audio'." });
      return;
    }
    const started = performance.now();
    const file = await toFile(req.file.buffer, req.file.originalname || "speech.webm", {
      type: req.file.mimetype || "audio/webm",
    });
    const result = await openai.audio.transcriptions.create({ file, model: s.config.llm.transcribeModel });
    res.json({ text: result.text, ms: Math.round(performance.now() - started) });
  });

  return router;
}
