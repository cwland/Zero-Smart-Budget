import type { ReactNode } from "react";

export function Card({ title, children, description }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-subtle">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export const field = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
export const primaryButton = "rounded bg-primary px-4 py-2.5 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60";
export const secondaryButton = "rounded border border-primary px-4 py-2.5 font-semibold text-primary hover:bg-pressed disabled:opacity-60";

export function Notice({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-success" : "text-error"}>
      {msg.text}
    </span>
  );
}
