import { useEffect } from "react";

// "You have unsaved changes": a screen with edits registers here. Leaving it through an in-app
// link (the sidebar, Settings tabs: hash changes) asks first, and so does closing or reloading
// the browser tab.
const dirty = new Map<string, string>(); // id -> what has unsaved changes
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  // Capture, so this runs before the pages' own hashchange listeners and can stop them
  window.addEventListener(
    "hashchange",
    (e) => {
      if (!dirty.size) return;
      const what = [...dirty.values()].join(", ");
      if (window.confirm(`You haven't saved your changes to ${what}. Leave without saving?`)) {
        dirty.clear();
        return;
      }
      e.stopImmediatePropagation();
      history.replaceState(null, "", e.oldURL); // back to where you were (doesn't fire hashchange)
    },
    true
  );
  window.addEventListener("beforeunload", (e) => {
    if (!dirty.size) return;
    e.preventDefault();
    e.returnValue = ""; // the browser shows its own "Leave site?" message
  });
}

export function useUnsavedGuard(id: string, isDirty: boolean, what: string) {
  useEffect(() => {
    install();
    if (isDirty) dirty.set(id, what);
    else dirty.delete(id);
    return () => {
      dirty.delete(id);
    };
  }, [id, isDirty, what]);
}
