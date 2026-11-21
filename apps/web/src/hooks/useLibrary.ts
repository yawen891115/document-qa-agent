import { useCallback, useEffect, useState } from "react";
import { deleteDocument, getHealth, listDocuments, loadSampleDocuments, uploadDocuments } from "../lib/api";
import type { DocumentRecord, HealthResponse } from "../types";

/** Documents in the knowledge base plus backend status. */
export function useLibrary() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [chunks, setChunks] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, list] = await Promise.all([getHealth(), listDocuments()]);
      setHealth(h);
      setDocuments(list.documents);
      setChunks(list.chunks);
      setApiDown(false);
    } catch {
      setApiDown(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setWorking(label);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setWorking(null);
        await refresh();
      }
    },
    [refresh],
  );

  return {
    documents,
    chunks,
    health,
    apiDown,
    working,
    error,
    upload: (files: File[]) =>
      run(files.length === 1 ? `Indexing ${files[0]!.name}…` : `Indexing ${files.length} files…`, () => uploadDocuments(files)),
    loadSamples: () => run("Indexing the sample documents…", loadSampleDocuments),
    remove: (doc: DocumentRecord) => run(`Removing ${doc.name}…`, () => deleteDocument(doc.id)),
    dismissError: () => setError(null),
  };
}
