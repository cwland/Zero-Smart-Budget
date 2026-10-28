// Keep password managers (1Password, LastPass, Bitwarden, Dashlane) from offering to save or fill
// on ordinary boxes: budget amounts, search, API secrets, settings... Every input gets their
// "ignore" markers, except inside a real sign-in form marked data-password-form (log in, setup,
// reset password, change password), where saving and filling is exactly what you want.

const MARKS: [string, string][] = [
  ["data-1p-ignore", "true"], // 1Password
  ["data-lpignore", "true"], // LastPass
  ["data-bwignore", "true"], // Bitwarden
  ["data-form-type", "other"], // Dashlane
];

function mark(el: Element) {
  if (el.closest("[data-password-form]")) return;
  for (const [k, v] of MARKS) if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}

function markAll(root: ParentNode) {
  root.querySelectorAll("input, textarea, select").forEach(mark);
}

export function keepPasswordManagersAway(root: HTMLElement) {
  markAll(root);
  new MutationObserver((changes) => {
    for (const c of changes) {
      c.addedNodes.forEach((n) => {
        if (n instanceof Element) {
          if (n.matches("input, textarea, select")) mark(n);
          markAll(n);
        }
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
