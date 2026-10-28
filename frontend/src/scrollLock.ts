import { useEffect } from "react";

// While a popup is open, the page behind it shouldn't scroll. Counts open popups so closing
// one of two doesn't unlock early, and keeps the scrollbar's space so nothing shifts sideways.
let locks = 0;
let saved = { overflow: "", htmlOverflow: "", paddingRight: "" };

export function useLockBodyScroll(active = true) {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    const html = document.documentElement; // the page scrolls on <html>, so lock both
    if (locks++ === 0) {
      saved = { overflow: body.style.overflow, htmlOverflow: html.style.overflow, paddingRight: body.style.paddingRight };
      const scrollbar = window.innerWidth - html.clientWidth;
      body.style.overflow = "hidden";
      html.style.overflow = "hidden";
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }
    return () => {
      if (--locks === 0) {
        body.style.overflow = saved.overflow;
        html.style.overflow = saved.htmlOverflow;
        body.style.paddingRight = saved.paddingRight;
      }
    };
  }, [active]);
}
