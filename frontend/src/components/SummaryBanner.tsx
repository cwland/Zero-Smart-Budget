import type { BudgetTotals } from "../api";
import { formatCents } from "../money";
import { Check } from "./Icons";

export default function SummaryBanner({ totals }: { totals: BudgetTotals }) {
  const left = totals.leftToBudgetCents;
  let content;

  if (totals.incomePlannedCents === 0 && totals.plannedCents === 0) {
    content = <span className="text-subtle">Add your planned income to get started</span>;
  } else if (left === 0) {
    content = (
      <span className="flex items-center gap-2 font-medium text-success">
        <span className="flex size-5 items-center justify-center rounded-full bg-success text-white">
          <Check className="size-3.5" />
        </span>
        Balanced! All of your income has a plan.
      </span>
    );
  } else if (left > 0) {
    content = (
      <span>
        <span className="tabular font-medium text-success">{formatCents(left)}</span> still to plan
      </span>
    );
  } else {
    content = (
      <span>
        <span className="tabular font-medium text-error">{formatCents(-left)}</span> planned beyond your income
      </span>
    );
  }

  return (
    <div role="status" className="flex h-[46px] items-center justify-center rounded-2xl bg-white px-4 text-lg shadow-[0_4px_12px_rgba(31,36,38,0.06)]">
      {content}
    </div>
  );
}
