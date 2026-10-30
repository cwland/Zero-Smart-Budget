import { readFileSync } from "node:fs";
import { emailColors, type EmailColors } from "./emailThemes.js";

// The branded layout every email uses: the logo and the colors of your theme, one white card,
// a button, and a footer. Built from simple blocks so the plain-text copy says the same thing.
// HTML email rules: tables for layout, inline styles only, no SVG (Gmail blocks it), no web fonts.

export type Tone = "good" | "bad" | "warn" | "plain";

export type Block =
  | { type: "p"; text: string } // **bold** is allowed
  | { type: "stats"; items: { label: string; value: string; tone?: Tone }[] }
  | { type: "rows"; title?: string; rows: { label: string; note?: string; value: string; tone?: Tone }[] }
  | { type: "callout"; text: string; tone?: Tone }
  | { type: "bullets"; items: string[] };

export interface EmailContent {
  subject: string;
  preheader?: string; // the preview line in the inbox
  title: string;
  blocks: Block[];
  button?: { label: string; url: string | null }; // url null: no app address set, so no button
  why: string; // footer: why you got this
  settingsPath?: string; // footer link, e.g. "/#/settings/notifications"
}

export interface RenderOptions {
  theme?: string | null;
  appUrl?: string | null;
  test?: { what: string } | null; // a sample: "[Test]" in the subject and a banner at the top
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: Buffer; cid: string; contentType: string }[];
}

const LOGO_CID = "zsb-logo";
const logoCache = new Map<string, Buffer>();
function logoPng(theme: string) {
  const id = ["harbor", "midnight-coral", "plum-amber", "terracotta-sage", "slate-rose"].includes(theme) ? theme : "harbor";
  if (!logoCache.has(id)) logoCache.set(id, readFileSync(new URL(`../../assets/email/logo-${id}.png`, import.meta.url)));
  return logoCache.get(id)!;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1");
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function toneColor(c: EmailColors, tone: Tone | undefined) {
  return tone === "good" ? c.success : tone === "bad" ? c.error : tone === "warn" ? "#b7791f" : c.ink;
}

function blockHtml(b: Block, c: EmailColors) {
  switch (b.type) {
    case "p":
      return `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${c.ink}">${rich(b.text)}</p>`;
    case "bullets":
      return `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:23px;color:${c.ink}">${b.items.map((i) => `<li style="margin:0 0 6px">${rich(i)}</li>`).join("")}</ul>`;
    case "callout": {
      const bg = b.tone === "bad" ? "#fdecea" : b.tone === "warn" ? "#fff6e0" : c["brand-subtle"];
      const bar = b.tone === "bad" ? c.error : b.tone === "warn" ? c.warning : c.brand;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${bg};border-left:4px solid ${bar};border-radius:6px;padding:12px 14px;font-size:15px;line-height:22px;color:${c.ink}">${rich(b.text)}</td></tr></table>`;
    }
    case "stats": {
      const w = Math.floor(100 / b.items.length);
      const cells = b.items
        .map(
          (s) =>
            `<td width="${w}%" style="padding:4px" valign="top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${c.page};border-radius:10px;padding:12px 10px;text-align:center"><div style="font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.5px;color:${c.muted}">${esc(s.label)}</div><div style="font-size:22px;line-height:30px;font-weight:700;color:${toneColor(c, s.tone)}">${esc(s.value)}</div></td></tr></table></td>`
        )
        .join("");
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:separate"><tr>${cells}</tr></table>`;
    }
    case "rows": {
      const title = b.title ? `<p style="margin:8px 0 6px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${c.subtle}">${esc(b.title)}</p>` : "";
      const rows = b.rows
        .map(
          (r) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid ${c.line};font-size:15px;line-height:20px;color:${c.ink}">${esc(r.label)}${r.note ? `<div style="font-size:13px;line-height:18px;color:${c.subtle}">${esc(r.note)}</div>` : ""}</td><td align="right" style="padding:10px 0 10px 12px;border-bottom:1px solid ${c.line};font-size:15px;line-height:20px;font-weight:600;white-space:nowrap;color:${toneColor(c, r.tone)}">${esc(r.value)}</td></tr>`
        )
        .join("");
      return `${title}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows}</table>`;
    }
  }
}

function blockText(b: Block) {
  switch (b.type) {
    case "p":
    case "callout":
      return plain(b.text);
    case "bullets":
      return b.items.map((i) => `- ${plain(i)}`).join("\n");
    case "stats":
      return b.items.map((s) => `${s.label}: ${s.value}`).join("\n");
    case "rows":
      return [b.title ? b.title.toUpperCase() : null, ...b.rows.map((r) => `- ${r.label}${r.note ? ` (${r.note})` : ""}: ${r.value}`)].filter(Boolean).join("\n");
  }
}

export function renderEmail(content: EmailContent, opts: RenderOptions = {}): RenderedEmail {
  const c = emailColors(opts.theme);
  const app = opts.appUrl?.replace(/\/+$/, "") ?? null;
  const subject = opts.test ? `[Test] ${content.subject}` : content.subject;
  const buttonUrl = content.button?.url ? (content.button.url.startsWith("http") ? content.button.url : app ? `${app}${content.button.url}` : null) : null;
  const settingsUrl = content.settingsPath && app ? `${app}${content.settingsPath}` : null;
  const preheader = content.preheader ?? "";

  const testBanner = opts.test
    ? `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#fff6e0;border:1px solid #f5d48a;border-radius:10px;padding:10px 14px;font-size:14px;line-height:20px;color:#6b4a00"><strong>Test email.</strong> This is a sample of ${esc(opts.test.what)}, sent from Settings. The real one looks like this.</td></tr></table></td></tr>`
    : "";
  const button = buttonUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="background:${c.action};border-radius:8px"><a href="${esc(buttonUrl)}" style="display:inline-block;padding:12px 22px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;font-family:${FONT}">${esc(content.button!.label)}</a></td></tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${c.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT}">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle"><img src="cid:${LOGO_CID}" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px"></td>
<td valign="middle" style="padding-left:10px"><div style="font-size:18px;line-height:22px;font-weight:700;color:${c.primary}">Zero Smart Budget</div><div style="font-size:12px;line-height:16px;color:${c.muted}">AI-Powered Zero-Based Budgeting</div></td>
</tr></table></td></tr>
${testBanner}
<tr><td style="background:#ffffff;border-radius:16px;padding:28px 24px;border-top:4px solid ${c.brand}">
<h1 style="margin:0 0 16px;font-size:24px;line-height:30px;font-weight:700;color:${c.primary}">${esc(content.title)}</h1>
${content.blocks.map((b) => blockHtml(b, c)).join("\n")}
${button}
</td></tr>
<tr><td style="padding:18px 8px 0;font-size:13px;line-height:19px;color:${c.muted};text-align:center">
${esc(content.why)}${settingsUrl ? ` <a href="${esc(settingsUrl)}" style="color:${c.link}">Change your email settings</a>.` : ""}<br>Zero Smart Budget runs on your own server. Nobody else sees your budget.
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    opts.test ? `TEST EMAIL: this is a sample of ${opts.test.what}, sent from Settings.\n` : null,
    content.title,
    "",
    content.blocks.map(blockText).join("\n\n"),
    buttonUrl ? `\n${content.button!.label}: ${buttonUrl}` : null,
    "\n--",
    content.why + (settingsUrl ? ` Change your email settings: ${settingsUrl}` : ""),
  ]
    .filter((x) => x !== null)
    .join("\n");

  return { subject, html, text, attachments: [{ filename: "logo.png", content: logoPng(opts.theme ?? "harbor"), cid: LOGO_CID, contentType: "image/png" }] };
}

// For showing an email in the browser (Settings preview): the logo inline instead of attached
export function previewHtml(e: RenderedEmail) {
  const logo = e.attachments.find((a) => a.cid === LOGO_CID);
  return logo ? e.html.replace(`cid:${LOGO_CID}`, `data:image/png;base64,${logo.content.toString("base64")}`) : e.html;
}
