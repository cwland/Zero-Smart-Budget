import type { Budget, Transaction } from "../api";
import { shortDate } from "../dates";
import { formatCents } from "../money";
import { assignmentLabel, isUnassigned, itemNames } from "./budgetLookup";

interface Props {
  budget: Budget;
  transactions: Transaction[];
  onAdd: () => void;
  onOpen: (t: Transaction) => void;
}

export function TransactionRow({ t, label, onOpen, amountCents }: { t: Transaction; label: string; onOpen: () => void; amountCents?: number }) {
  const amount = amountCents ?? t.amountCents;
  return (
    <li>
      <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-pressed">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{t.merchant}</span>
          <span className="block truncate text-sm text-subtle">
            {shortDate(t.date)} · <span className={label === "Unassigned" ? "font-medium text-warning" : ""}>{label}</span>
          </span>
        </span>
        <span className={`tabular shrink-0 ${t.type === "income" ? "text-success" : ""}`}>
          {t.type === "income" ? "+" : ""}
          {formatCents(amount)}
        </span>
      </button>
    </li>
  );
}

export default function TransactionList({ budget, transactions, onAdd, onOpen }: Props) {
  const names = itemNames(budget);
  const unassigned = transactions.filter(isUnassigned);
  const assigned = transactions.filter((t) => !isUnassigned(t));

  return (
    <div className="p-2">
      <button onClick={onAdd} className="w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed">
        Add Transaction
      </button>

      {unassigned.length > 0 && (
        <section aria-label="Unassigned transactions" className="mt-5 rounded-xl border border-warning/50 bg-warning/5 p-2">
          <h3 className="px-2 pt-1 text-sm font-semibold uppercase tracking-wide text-subtle">
            Unassigned <span className="ml-1 rounded-full bg-warning px-2 py-0.5 text-xs text-white">{unassigned.length}</span>
          </h3>
          <ul>
            {unassigned.map((t) => (
              <TransactionRow key={t.id} t={t} label="Unassigned" onOpen={() => onOpen(t)} />
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Transactions this month" className="mt-5">
        <h3 className="px-2 text-sm font-semibold uppercase tracking-wide text-subtle">This month</h3>
        {assigned.length === 0 ? (
          <p className="px-2 py-8 text-center text-subtle">No transactions yet</p>
        ) : (
          <ul className="divide-y divide-line">
            {assigned.map((t) => (
              <TransactionRow key={t.id} t={t} label={assignmentLabel(t, names)} onOpen={() => onOpen(t)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
