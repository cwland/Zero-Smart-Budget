import { useState } from "react";
import type { MissingMonth } from "../api";
import { monthLabel } from "../dates";

interface Props {
  missing: MissingMonth;
  onCreate: (mode: "blank" | "template" | "copy") => Promise<void>;
}

export default function CreateMonth({ missing, onCreate }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async (mode: "blank" | "template" | "copy") => {
    setBusy(true);
    try {
      await onCreate(mode);
    } finally {
      setBusy(false);
    }
  };

  const secondary = "w-full rounded border border-primary py-3 font-semibold text-primary hover:bg-pressed disabled:opacity-60";

  return (
    <div className="rounded-2xl bg-white p-8 text-center">
      <h2 className="text-xl font-semibold">Start your {monthLabel(missing)} budget</h2>
      <p className="mt-2 text-subtle">Plan where this month's income will go. How would you like to start?</p>
      {!!missing.waitingTransactions && (
        <p role="status" className="mx-auto mt-4 max-w-sm rounded-lg bg-warning/10 px-4 py-2 text-sm text-ink">
          {missing.waitingTransactions} {missing.waitingTransactions === 1 ? "transaction is" : "transactions are"} already waiting for this month. They'll show up once you create it.
        </p>
      )}
      <div className="mx-auto mt-6 flex max-w-xs flex-col gap-3">
        {missing.canCopyFrom && (
          <button
            disabled={busy}
            onClick={() => run("copy")}
            className="w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60"
          >
            Copy {monthLabel(missing.canCopyFrom)}
          </button>
        )}
        <button disabled={busy} onClick={() => run("template")} className={missing.canCopyFrom ? secondary : secondary.replace("border border-primary", "bg-primary").replace("text-primary hover:bg-pressed", "text-white hover:bg-primary-pressed")}>
          Start with suggested categories
        </button>
        <button disabled={busy} onClick={() => run("blank")} className="py-2 font-semibold text-action hover:underline disabled:opacity-60">
          Start from scratch
        </button>
      </div>
    </div>
  );
}
