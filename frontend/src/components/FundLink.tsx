import { useEffect, useState } from "react";
import { api, type SinkingFund } from "../api";
import { formatCents, parseMoney } from "../money";
import { PiggyIcon } from "./Icons";

interface Props {
  lineItemId: number;
  fund: { id: number; name: string; targetCents: number | null; balanceCents: number } | null;
  onChanged: () => Promise<void>;
}

// Picker in the item detail panel: link this budget item to a sinking fund (or create one)
export default function FundLink({ lineItemId, fund, onChanged }: Props) {
  const [funds, setFunds] = useState<SinkingFund[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<SinkingFund[]>("GET", "/api/funds")
      .then(setFunds)
      .catch(() => setFunds([]));
  }, [fund?.id]);

  async function link(fundId: number | null) {
    setError("");
    try {
      await api("PATCH", `/api/items/${lineItemId}`, { sinkingFundId: fundId });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createAndLink() {
    const targetCents = target.trim() ? parseMoney(target) : null;
    if (!name.trim()) return setError("Give the fund a name");
    if (target.trim() && targetCents === null) return setError("Target isn't a valid amount");
    try {
      const created = await api<{ id: number }>("POST", "/api/funds", { name: name.trim(), targetCents: targetCents || null });
      setCreating(false);
      setName("");
      setTarget("");
      await link(created.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Keep the linked fund in the list even if it's archived
  const choices = fund && !funds.some((f) => f.id === fund.id) ? [...funds, { id: fund.id, name: fund.name }] : funds;
  const field = "w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";

  return (
    <div className="mt-4 rounded-lg bg-brand-subtle p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-success">
        <PiggyIcon className="size-5" />
        Sinking fund
      </div>

      {fund && (
        <div className="tabular mt-1 text-sm">
          <strong>{fund.name}</strong>: {formatCents(fund.balanceCents)}
          {fund.targetCents ? ` of ${formatCents(fund.targetCents)}` : ""}
        </div>
      )}

      {!creating ? (
        <select
          aria-label="Sinking fund"
          value={fund?.id ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "new") setCreating(true);
            else void link(v ? Number(v) : null);
          }}
          className={`${field} mt-2 text-sm`}
        >
          <option value="">Not a sinking fund</option>
          {choices.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          <option value="new">+ New fund…</option>
        </select>
      ) : (
        <div className="mt-2 flex flex-col gap-2" onKeyDown={(e) => e.key === "Escape" && setCreating(false)}>
          <input autoFocus aria-label="New fund name" placeholder="Fund name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAndLink()} className={`${field} text-sm`} />
          <input aria-label="New fund target" placeholder="Target (optional)" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAndLink()} className={`${field} tabular text-sm`} />
          <div className="flex gap-2">
            <button onClick={createAndLink} className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-pressed">
              Create & link
            </button>
            <button onClick={() => setCreating(false)} className="rounded px-3 py-2 text-sm font-semibold text-action hover:bg-pressed">
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}
