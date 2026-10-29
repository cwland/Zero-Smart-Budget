import { useEffect } from "react";

// While a popup is open, the page behind it shouldn't scroll. Counts open popups so closing
// one of two doesn't unlock early, and keeps the scrollbar's space so nothing shifts sideways.
// Only <html> (the page's scroller) is locked: hiding overflow on <body> too turns <body> into a
// scroll box, and the left nav (position: sticky) then jumps away while a popup is open.
let locks = 0;
let saved = { htmlOverflow: "", paddingRight: "" };

export function useLockBodyScroll(active = true) {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    if (locks++ === 0) {
      saved = { htmlOverflow: html.style.overflow, paddingRight: html.style.paddingRight };
      const scrollbar = window.innerWidth - html.clientWidth;
      html.style.overflow = "hidden";
      if (scrollbar > 0) html.style.paddingRight = `${scrollbar}px`;
    }
    return () => {
      if (--locks === 0) {
        html.style.overflow = saved.htmlOverflow;
        html.style.paddingRight = saved.paddingRight;
      }
    };
  }, [active]);
}
