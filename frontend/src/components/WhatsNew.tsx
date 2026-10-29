import { useState } from "react";
import { CHANGELOG, isNewer, type Release } from "../changelog";
import { APP_VERSION } from "../version";
import { Popup } from "./Popup";

const longDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

// "What's new", newest first. After an update (all = false): the versions since the one you last
// dismissed (or just this one), with earlier versions a click away. From the version number
// (all = true): every version.
export default function WhatsNew({ since, all = false, onClose }: { since?: string | null; all?: boolean; onClose: () => void }) {
  const released = CHANGELOG.filter((r) => !isNewer(r.version, APP_VERSION));
  const fresh = since ? released.filter((r) => isNewer(r.version, since)) : released.slice(0, 1);
  const shownFirst = fresh.length ? fresh : released.slice(0, 1);
  const [showAll, setShowAll] = useState(all);
  const list = showAll ? released : shownFirst;
  const earlier = released.length - shownFirst.length;

  return (
    <Popup title="What's new" wide onClose={onClose}>
      <div className="flex flex-col gap-6 px-6 py-5">
        <p className="text-sm text-subtle">Zero Smart Budget v{APP_VERSION}. Newest changes first.</p>
        {list.map((r) => (
          <ReleaseNotes key={r.version} r={r} current={r.version === APP_VERSION} />
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          {!showAll && earlier > 0 ? (
            <button type="button" onClick={() => setShowAll(true)} className="text-sm font-semibold text-link hover:underline">
              Earlier versions ({earlier})
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={onClose} className="rounded bg-primary px-5 py-2.5 font-semibold text-white hover:bg-primary-pressed">
            Got it
          </button>
        </div>
      </div>
    </Popup>
  );
}

function ReleaseNotes({ r, current }: { r: Release; current: boolean }) {
  return (
    <section aria-label={`Version ${r.version}`}>
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold">
        Version {r.version}
        {r.title && <span className="font-normal text-subtle">· {r.title}</span>}
        {current && <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-xs font-semibold text-success">This version</span>}
      </h3>
      <p className="text-sm text-muted">{longDate(r.date)}</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">
        {r.changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </section>
  );
}
