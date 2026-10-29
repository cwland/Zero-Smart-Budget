import type { Budget, Transaction } from "../api";
import { formatCents } from "../money";
import { ChevronLeft, StarIcon } from "./Icons";
import { api } from "../api";
import FundLink from "./FundLink";
import { ProgressBar } from "./ItemRow";
import { TransactionRow } from "./TransactionList";

export type ItemRef = { type: "line" | "income"; id: number };

interface Props {
  budget: Budget;
  item: ItemRef;
  transactions: Transaction[];
  onAdd: () => void;
  onOpen: (t: Transaction) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export default function ItemDetail({ budget, item, transactions, onAdd, onOpen, onClose, onChanged }: Props) {
  let name = "";
  let groupName = "";
  let planned = 0;
  let actual = 0;
  let fund: Budget["groups"][number]["items"][number]["sinkingFund"] = null;
  let favorite = false;

  if (item.type === "income") {
    const i = budget.income.find((x) => x.id === item.id);
    if (!i) return null;
    ({ name, plannedCents: planned, receivedCents: actual } = i);
    groupName = "Income";
  } else {
    for (const g of budget.groups) {
      const i = g.items.find((x) => x.id === item.id);
      if (i) {
        ({ name, plannedCents: planned, spentCents: actual, sinkingFund: fund, favorite } = i);
        groupName = g.name;
      }
    }
    if (!name) return null;
  }

  const remaining = planned - actual;
  const matches = transactions
    .map((t) => ({
      t,
      share: t.splits
        .filter((s) => (item.type === "line" ? s.lineItemId === item.id : s.incomeItemId === item.id))
        .reduce((sum, s) => sum + s.amountCents, 0),
    }))
    .filter((m) => m.share > 0);

  const stat = (label: string, value: number, cls = "") => (
    <div className="flex-1 rounded-lg bg-page px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`tabular mt-0.5 font-semibold ${cls}`}>{formatCents(value)}</div>
    </div>
  );

  return (
    <div aria-label={`${name} details`} role="region" className="p-2">
      <div className="flex items-center gap-2">
        <button onClick={onClose} aria-label="Back to summary" className="rounded p-1 text-action hover:bg-pressed">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-subtle">{groupName}</div>
          <h2 className="truncate text-lg font-semibold">{name}</h2>
        </div>
        {item.type === "line" && (
          <button
            onClick={async () => {
              await api("PATCH", `/api/items/${item.id}`, { favorite: !favorite });
              await onChanged();
            }}
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={favorite}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            className={`rounded-full p-2 hover:bg-page ${favorite ? "text-[#f5b301]" : "text-muted"}`}
          >
            <StarIcon filled={favorite} />
          </button>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        {stat("Planned", planned)}
        {stat(item.type === "income" ? "Received" : "Spent", actual)}
        {stat("Remaining", remaining, remaining < 0 ? "text-error" : "text-success")}
      </div>
      <div className="mt-3">
        <ProgressBar actual={actual} planned={planned} />
      </div>

      {item.type === "line" && <FundLink lineItemId={item.id} fund={fund} onChanged={onChanged} />}

      <button onClick={onAdd} className="mt-5 w-full rounded border border-primary py-2.5 font-semibold text-primary hover:bg-pressed">
        Add Transaction
      </button>

      <h3 className="mt-5 px-2 text-sm font-semibold uppercase tracking-wide text-subtle">Transactions</h3>
      {matches.length === 0 ? (
        <p className="px-2 py-6 text-center text-subtle">Nothing yet this month</p>
      ) : (
        <ul className="divide-y divide-line">
          {matches.map(({ t, share }) => (
            <TransactionRow
              key={t.id}
              t={t}
              amountCents={share}
              label={t.splits.length > 1 ? `Split · ${formatCents(t.amountCents)} total` : t.note || (item.type === "income" ? "Income" : t.type === "income" ? "Money back" : "Expense")}
              onOpen={() => onOpen(t)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
