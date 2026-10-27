import { useState } from "react";

export default function AddGroup({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  async function save() {
    const trimmed = name.trim();
    setEditing(false);
    setName("");
    if (trimmed) await onAdd(trimmed);
  }

  if (editing) {
    return (
      <div className="rounded-lg border-2 border-dotted border-strong bg-white p-4">
        <input
          autoFocus
          aria-label="New group name"
          placeholder="Group name (e.g. Kids, Pets)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setName("");
              setEditing(false);
            }
          }}
          className="w-full rounded border border-action px-2 py-2 text-lg outline-none ring-2 ring-action/15"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="w-full rounded-lg border-2 border-dotted border-strong p-6 font-semibold text-action hover:bg-white"
    >
      Add Group
    </button>
  );
}
