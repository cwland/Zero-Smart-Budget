// The "toss" when you accept a suggestion: a copy of the transaction row lobs in an arc into its
// budget item, which flashes as it lands (like the Toss to Budget Item preview). If the item is
// off screen, the page scrolls it into view first. Turned off in Settings > Budget, and skipped
// when the system asks for reduced motion.

const DURATION = 750; // ms: "Normal"
const ARC = 140; // px: "Medium"
const SPIN = 14; // degrees at the top of the arc: "A little"
const END_SCALE = 0.42; // shrinks as it drops into the item

let enabled = true;
export const setTossEnabled = (on: boolean) => {
  enabled = on;
};
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
export const tossOn = () => enabled && !reducedMotion();

// The budget item row a target ("l:12" / "i:3") lands on, if it's on the page
export const itemRowFor = (target: string) => document.querySelector<HTMLElement>(`[data-item-row="${target}"]`);
export const targetOf = (s: { lineItemId?: number | null; incomeItemId?: number | null }) =>
  s.lineItemId ? `l:${s.lineItemId}` : s.incomeItemId ? `i:${s.incomeItemId}` : "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Scroll the item into view (if needed) and wait until the page stops moving
async function bringIntoView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const margin = 80;
  if (r.top >= margin && r.bottom <= window.innerHeight - margin) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  let last = NaN;
  for (let i = 0; i < 40; i++) {
    await sleep(40);
    const top = el.getBoundingClientRect().top;
    if (Math.abs(top - last) < 0.5) break;
    last = top;
  }
}

// Fold the source row away while its copy flies
function collapse(row: HTMLElement) {
  const h = row.getBoundingClientRect().height;
  row.style.maxHeight = `${h}px`;
  row.style.overflow = "hidden";
  void row.offsetHeight;
  row.style.transition = "max-height .35s cubic-bezier(.4,0,.2,1), opacity .2s, padding .35s";
  row.style.maxHeight = "0px";
  row.style.opacity = "0";
  row.style.paddingTop = "0px";
  row.style.paddingBottom = "0px";
}

/**
 * Toss a transaction row into a budget item. Resolves when it lands (right away if tossing is
 * off or the item isn't on this page). ai: purple border instead of blue.
 */
export async function toss(source: HTMLElement | null, target: string, opts: { ai?: boolean } = {}) {
  if (!source || !tossOn()) return;
  const dest = itemRowFor(target);
  if (!dest) return;
  await bringIntoView(dest);

  const from = source.getBoundingClientRect();
  const to = dest.getBoundingClientRect();
  // Start from where the row is; if scrolling moved it off screen, launch from the nearest edge
  const startX = from.left;
  const startY = Math.min(Math.max(from.top, 8), window.innerHeight - from.height - 8);

  const fly = document.createElement("div");
  fly.setAttribute("aria-hidden", "true");
  fly.style.cssText = `position:fixed;top:0;left:0;z-index:70;pointer-events:none;will-change:transform;width:${from.width}px`;
  const copy = source.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-tx-row");
  copy.querySelectorAll("button[aria-label^='Assign'], input[type=checkbox]").forEach((n) => n.remove());
  copy.style.cssText += `;background:var(--color-white,#fff);border:2px solid ${opts.ai ? "#7c4dff" : "#0073b9"};border-radius:12px;box-shadow:0 14px 30px rgba(15,30,40,.28);list-style:none;margin:0`;
  fly.appendChild(copy);
  document.body.appendChild(fly);
  collapse(source);

  const endX = to.left + 24 - (from.width * (1 - END_SCALE)) / 2;
  const endY = to.top + to.height / 2 - from.height / 2;
  const spin = to.left < startX ? -SPIN : SPIN;

  await new Promise<void>((done) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION);
      const ease = 1 - Math.pow(1 - p, 2.2); // quick release, slowing into the catch
      const x = startX + (endX - startX) * ease;
      const y = startY + (endY - startY) * ease - 4 * ARC * p * (1 - p); // the lob
      const scale = 1 + Math.sin(p * Math.PI) * 0.06 - (1 - END_SCALE) * Math.pow(p, 3);
      fly.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${spin * Math.sin(p * Math.PI)}deg) scale(${scale})`;
      fly.style.opacity = p > 0.82 ? String(1 - (p - 0.82) / 0.18) : "1";
      if (p < 1) requestAnimationFrame(frame);
      else {
        fly.remove();
        done();
      }
    };
    requestAnimationFrame(frame);
  });
}

// The catch: the item flashes and its Spent/Received amount gives a little bump.
// Called after the budget refreshes, so it finds the re-rendered row.
export function flash(target: string) {
  if (!tossOn()) return;
  const row = itemRowFor(target);
  if (!row) return;
  row.classList.remove("toss-catch");
  void row.offsetWidth;
  row.classList.add("toss-catch");
  const amount = row.querySelector<HTMLElement>("[data-item-amount]");
  amount?.classList.remove("toss-bump");
  void amount?.offsetWidth;
  amount?.classList.add("toss-bump");
  setTimeout(() => {
    row.classList.remove("toss-catch");
    amount?.classList.remove("toss-bump");
  }, 700);
}
