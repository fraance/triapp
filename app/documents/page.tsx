"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";

interface Doc {
  id: string;
  filename: string;
  fileType: string;
  rowCount: number | null;
  includeInAi: boolean;
  createdAt: string;
  preview: string;
}

export default function DocumentsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetch(`/api/documents?userId=${user.id}`).then((r) =>
        r.json()
      );
      setDocs(data.documents || []);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setUploading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("userId", user.id);
      form.append("file", file);

      const res = await fetch("/api/documents", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      setMessage(
        `Uploaded "${data.filename}" — ${data.rowCount ?? 0} rows read. Your coach will use this.`
      );
      await load();
    } catch (err: any) {
      setMessage(err.message || "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function toggle(doc: Doc) {
    if (!user) return;
    await fetch("/api/documents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        documentId: doc.id,
        includeInAi: !doc.includeInAi,
      }),
    });
    await load();
  }

  async function remove(doc: Doc) {
    if (!user) return;
    await fetch("/api/documents", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, documentId: doc.id }),
    });
    await load();
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-inner-narrow">
        <header className="mb-6">
          <h1 className="page-title">
            Context for your coach
          </h1>
        </header>

        <div className="card card-pad mb-6">
          <p className="text-gray-700 mb-4">
            Upload spreadsheets or notes — past performances, previous training
            plans, test results. Your AI coach reads these when building your
            plan.
          </p>
          <p className="text-sm text-gray-500 mb-4">
            Supported: .xlsx, .xls, .csv, .txt, .md (max 10 MB)
          </p>
          <input
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md"
            onChange={handleUpload}
            disabled={uploading}
            className="block w-full text-gray-700"
          />
          {uploading && <p className="text-indigo-600 mt-3">Uploading...</p>}
          {message && (
            <div className="mt-4 alert alert-info">{message}</div>
          )}
        </div>

        {docs.length > 0 && (
          <div className="card card-pad">
            <h2 className="text-xl font-bold text-indigo-900 mb-4">
              Uploaded files ({docs.length})
            </h2>
            <div className="space-y-4">
              {docs.map((d) => (
                <div key={d.id} className="border border-gray-200 rounded p-4">
                  <div className="flex justify-between items-start gap-4 mb-2">
                    <div>
                      <p className="font-semibold text-gray-800">{d.filename}</p>
                      <p className="text-sm text-gray-500">
                        {d.fileType.toUpperCase()} ·{" "}
                        {d.rowCount ? `${d.rowCount} rows · ` : ""}
                        {new Date(d.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2 whitespace-nowrap">
                      <button
                        onClick={() => toggle(d)}
                        className={`btn btn-sm ${
                          d.includeInAi ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                        }`}
                      >
                        {d.includeInAi ? "Used by coach" : "Ignored"}
                      </button>
                      <button
                        onClick={() => remove(d)}
                        className="btn btn-sm btn-danger-soft"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                    {d.preview}
                    {d.preview.length >= 400 ? "..." : ""}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
