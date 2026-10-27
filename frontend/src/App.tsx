import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus("API not reachable"));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-slate-800">Cory's Dollar</h1>
        <p className="mt-2 text-slate-500">API status: {status}</p>
      </div>
    </div>
  );
}
