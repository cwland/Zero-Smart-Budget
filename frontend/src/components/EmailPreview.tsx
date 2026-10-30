import { useEffect, useState } from "react";
import { getToken } from "../api";
import { Popup } from "./Popup";

// Shows a notification email the way it will arrive (from /api/settings/notifications/preview),
// without sending anything
export default function EmailPreview({ kind, title, onClose }: { kind: string; title: string; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const token = getToken();
    fetch(`/api/settings/notifications/preview?kind=${encodeURIComponent(kind)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (r) => (r.ok ? setHtml(await r.text()) : setError((await r.json().catch(() => ({}))).error ?? `Couldn't load the preview (${r.status})`)))
      .catch((e) => setError((e as Error).message));
  }, [kind]);
  return (
    <Popup title={title} onClose={onClose} wide tall>
      {error ? (
        <p role="alert" className="p-6 text-error">
          {error}
        </p>
      ) : html === null ? (
        <p className="p-6 text-center text-subtle" aria-busy="true">
          Loading the preview…
        </p>
      ) : (
        <iframe title={`${title} email`} srcDoc={html} sandbox="" className="h-[calc(85vh-4.5rem)] w-full border-0" />
      )}
    </Popup>
  );
}
