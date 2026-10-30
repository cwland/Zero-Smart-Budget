import type { EmailContent } from "./emailLayout.js";

// The wording of every email the app sends. Each returns content for renderEmail().

export const NOTIFY_SETTINGS = "/#/settings/notifications";
const notifyWhy = "You're getting this because it's turned on in Settings › Notifications.";

export function emailWorks(): EmailContent {
  return {
    subject: "Zero Smart Budget email is working",
    preheader: "Your email settings are working.",
    title: "Email is working",
    blocks: [
      { type: "p", text: "Your email settings are working. Password reset links and notifications will arrive like this one." },
      { type: "callout", text: "If this landed in spam, mark it as **not spam** so the real ones reach your inbox." },
    ],
    button: { label: "Open Zero Smart Budget", url: "/" },
    why: "You sent this from Settings › Email.",
    settingsPath: "/#/settings/email",
  };
}

export function passwordReset(username: string, link: string): EmailContent {
  return {
    subject: "Reset your Zero Smart Budget password",
    preheader: "This link works once, for 1 hour.",
    title: "Reset your password",
    blocks: [
      { type: "p", text: `Someone (hopefully you) asked to reset the password for **${username}**.` },
      { type: "p", text: "Use the button below to pick a new one. The link works once, for 1 hour." },
    ],
    button: { label: "Reset my password", url: link },
    why: "If this wasn't you, ignore this email. Your password won't change.",
  };
}

export function invitation(p: { from: string; name: string | null; role: "admin" | "user"; link: string; days: number }): EmailContent {
  const what =
    p.role === "admin"
      ? "As an **admin** you can do everything in the app, including its settings, except inviting people."
      : "As a **user** you can use the budget, transactions, accounts and reports, and set up your own profile and notifications.";
  return {
    subject: `${p.from} shared their budget with you`,
    preheader: `Set up your sign-in. The link works for ${p.days} days.`,
    title: `${p.name ? `Hi ${p.name}, you're` : "You're"} invited`,
    blocks: [
      { type: "p", text: `**${p.from}** invited you to their budget in Zero Smart Budget.` },
      { type: "p", text: what },
      { type: "p", text: `Use the button below to pick a username and password. The link works once, for ${p.days} days.` },
    ],
    button: { label: "Set up my sign-in", url: p.link },
    why: "You got this because someone added your email address to their budget. If you didn't expect it, ignore this email.",
  };
}

export function monthCloseReminder(p: { monthName: string; over: boolean; leftCents?: number | null; spentCents?: number | null; plannedCents?: number | null }): EmailContent {
  const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const blocks: EmailContent["blocks"] = [
    { type: "p", text: `${p.monthName} ${p.over ? "is over" : "is almost over"}. Wrap it up to see where you came out ahead or went over, and decide where any extra money goes.` },
  ];
  if (p.plannedCents != null && p.spentCents != null) {
    const left = p.plannedCents - p.spentCents;
    blocks.push({
      type: "stats",
      items: [
        { label: "Planned", value: money(p.plannedCents) },
        { label: "Spent", value: money(p.spentCents) },
        { label: left >= 0 ? "Left" : "Over", value: money(left), tone: left >= 0 ? "good" : "bad" },
      ],
    });
  }
  return {
    subject: `Time to wrap up ${p.monthName}`,
    preheader: `${p.monthName} ${p.over ? "is over" : "ends soon"}. Wrap it up in a couple of minutes.`,
    title: `Time to wrap up ${p.monthName}`,
    blocks,
    button: { label: `Wrap up ${p.monthName}`, url: "/#/budget" },
    why: notifyWhy,
    settingsPath: NOTIFY_SETTINGS,
  };
}

export function nudge(p: { waiting: number; days: number; examples?: { merchant: string; amount: string; date: string }[] }): EmailContent {
  const s = p.waiting === 1;
  const blocks: EmailContent["blocks"] = [
    { type: "p", text: `It's been **${p.days} day${p.days === 1 ? "" : "s"}** since you last checked your budget, and **${p.waiting} transaction${s ? "" : "s"}** ${s ? "hasn't" : "haven't"} been given a budget item yet.` },
  ];
  if (p.examples?.length) blocks.push({ type: "rows", title: "Waiting for you", rows: p.examples.map((e) => ({ label: e.merchant, note: e.date, value: e.amount })) });
  blocks.push({ type: "p", text: "A few minutes now keeps your budget on track." });
  return {
    subject: `${p.waiting} transaction${s ? " is" : "s are"} waiting for you`,
    preheader: `${p.waiting} transaction${s ? " needs" : "s need"} a budget item.`,
    title: `${p.waiting} transaction${s ? " is" : "s are"} waiting`,
    blocks,
    button: { label: "Assign transactions", url: "/#/budget" },
    why: notifyWhy,
    settingsPath: NOTIFY_SETTINGS,
  };
}

// ---------- Step 2 notifications ----------

export const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (c: number) => `${c < 0 ? "-" : ""}$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;
const base = { why: notifyWhy, settingsPath: NOTIFY_SETTINGS };

export interface MonthlySummaryData {
  monthName: string;
  incomeCents: number;
  spentCents: number;
  plannedCents: number;
  groups: { name: string; spentCents: number; plannedCents: number }[];
  unusual: { item: string; group: string; cents: number; usualCents: number }[];
  aiBullets?: string[] | null;
  aiService?: string | null;
}
export function monthlySummary(d: MonthlySummaryData): EmailContent {
  const kept = d.incomeCents - d.spentCents;
  const rate = d.incomeCents > 0 ? Math.round((kept / d.incomeCents) * 100) : null;
  const blocks: EmailContent["blocks"] = [
    {
      type: "stats",
      items: [
        { label: "Income", value: whole(d.incomeCents) },
        { label: "Spent", value: whole(d.spentCents) },
        { label: rate === null ? "Kept" : "Saved", value: rate === null ? whole(kept) : `${rate}%`, tone: kept >= 0 ? "good" : "bad" },
      ],
    },
    {
      type: "p",
      text:
        kept >= 0
          ? `You kept **${whole(kept)}** of what came in, and spent ${whole(d.spentCents)} of the ${whole(d.plannedCents)} you planned.`
          : `You spent **${whole(-kept)} more** than came in, and ${whole(d.spentCents)} of the ${whole(d.plannedCents)} you planned.`,
    },
  ];
  if (d.groups.length)
    blocks.push({
      type: "rows",
      title: "Where it went",
      rows: d.groups.map((g) => {
        const over = g.spentCents > g.plannedCents && g.plannedCents > 0;
        return { label: g.name, note: g.plannedCents ? `${whole(g.plannedCents)} planned${over ? `, ${whole(g.spentCents - g.plannedCents)} over` : ""}` : "nothing planned", value: whole(g.spentCents), tone: over ? "bad" : "plain" };
      }),
    });
  if (d.unusual.length)
    blocks.push({ type: "rows", title: "More than usual", rows: d.unusual.map((u) => ({ label: u.item, note: `${u.group} · usually ${whole(u.usualCents)}`, value: whole(u.cents), tone: "bad" })) });
  if (d.aiBullets?.length) {
    blocks.push({ type: "p", text: `**In short**${d.aiService ? ` (written by ${d.aiService})` : ""}` });
    blocks.push({ type: "bullets", items: d.aiBullets });
  }
  return {
    ...base,
    subject: `Your ${d.monthName} summary`,
    preheader: rate === null ? `You spent ${whole(d.spentCents)} in ${d.monthName}.` : `You saved ${rate}% of your income in ${d.monthName}.`,
    title: `${d.monthName} in review`,
    blocks,
    button: { label: "See your reports", url: "/#/reports" },
  };
}

export function bankAttention(d: { bank: string; status: "login_required" | "error"; message?: string | null; lastSynced?: string | null }): EmailContent {
  return {
    ...base,
    subject: d.status === "login_required" ? `${d.bank} needs you to sign in again` : `${d.bank} stopped updating`,
    preheader: "New transactions won't come in until you reconnect.",
    title: d.status === "login_required" ? `Reconnect ${d.bank}` : `${d.bank} stopped updating`,
    blocks: [
      {
        type: "p",
        text:
          d.status === "login_required"
            ? `Your connection to **${d.bank}** needs you to sign in again (banks ask for this now and then, often after a password change). Until you do, new transactions won't come in.`
            : `Zero Smart Budget couldn't get new transactions from **${d.bank}**. Until it's fixed, new transactions won't come in.`,
      },
      ...(d.message ? [{ type: "callout" as const, text: `The bank said: ${d.message}`, tone: "warn" as const }] : []),
      ...(d.lastSynced ? [{ type: "p" as const, text: `Last update: ${d.lastSynced}.` }] : []),
    ],
    button: { label: "Reconnect on the Accounts page", url: "/#/accounts" },
  };
}

export function overBudget(d: { monthName: string; items: { item: string; group: string; spentCents: number; plannedCents: number }[] }): EmailContent {
  const one = d.items.length === 1;
  return {
    ...base,
    subject: one ? `${d.items[0].item} is over budget` : `${d.items.length} items are over budget`,
    preheader: one ? `${whole(d.items[0].spentCents - d.items[0].plannedCents)} over in ${d.monthName}.` : `In ${d.monthName}: ${d.items.map((i) => i.item).join(", ")}.`,
    title: one ? `${d.items[0].item} went over` : `${d.items.length} items went over`,
    blocks: [
      { type: "p", text: `${one ? "This item has" : "These items have"} spent more than planned in ${d.monthName}:` },
      { type: "rows", rows: d.items.map((i) => ({ label: i.item, note: `${i.group} · ${whole(i.spentCents)} of ${whole(i.plannedCents)}`, value: `${whole(i.spentCents - i.plannedCents)} over`, tone: "bad" })) },
      { type: "p", text: "To stay zero-based, move money in from an item that has some left, or plan less somewhere else." },
    ],
    button: { label: "Open your budget", url: "/#/budget" },
  };
}

export function weeklyCheckIn(d: { weekSpentCents: number; topMerchants: { name: string; cents: number }[]; leftCents: number; plannedCents: number; daysLeft: number; monthName: string; close: { item: string; leftCents: number }[]; over: { item: string; overCents: number }[]; waiting: number }): EmailContent {
  const blocks: EmailContent["blocks"] = [
    {
      type: "stats",
      items: [
        { label: "Spent this week", value: whole(d.weekSpentCents) },
        { label: `Left in ${d.monthName.split(" ")[0]}`, value: whole(d.leftCents), tone: d.leftCents >= 0 ? "good" : "bad" },
        { label: "Days left", value: String(d.daysLeft) },
      ],
    },
  ];
  if (d.topMerchants.length) blocks.push({ type: "rows", title: "Biggest this week", rows: d.topMerchants.map((m) => ({ label: m.name, value: whole(m.cents) })) });
  if (d.over.length) blocks.push({ type: "rows", title: "Over budget", rows: d.over.map((o) => ({ label: o.item, value: `${whole(o.overCents)} over`, tone: "bad" })) });
  if (d.close.length) blocks.push({ type: "rows", title: "Almost used up", rows: d.close.map((c) => ({ label: c.item, value: `${whole(c.leftCents)} left`, tone: "warn" })) });
  if (d.waiting) blocks.push({ type: "callout", text: `**${d.waiting} transaction${d.waiting === 1 ? "" : "s"}** ${d.waiting === 1 ? "is" : "are"} waiting for a budget item.` });
  return {
    ...base,
    subject: `Your week: ${whole(d.weekSpentCents)} spent, ${whole(d.leftCents)} left`,
    preheader: `${d.daysLeft} days left in ${d.monthName}.`,
    title: "Your weekly check-in",
    blocks,
    button: { label: "Open your budget", url: "/#/budget" },
  };
}

export function goalMilestone(d: { name: string; pct: number; balanceCents: number; targetCents: number; targetDate?: string | null; kind: "goal" | "sinking" }): EmailContent {
  const done = d.pct >= 100;
  return {
    ...base,
    subject: done ? `You reached your ${d.name} ${d.kind === "goal" ? "goal" : "target"}!` : `${d.name}: ${d.pct}% of the way there`,
    preheader: `${whole(d.balanceCents)} of ${whole(d.targetCents)} saved.`,
    title: done ? `🎉 ${d.name} is fully funded` : `${d.pct}% of the way to ${d.name}`,
    blocks: [
      { type: "stats", items: [{ label: "Saved", value: whole(d.balanceCents), tone: "good" }, { label: "Target", value: whole(d.targetCents) }, { label: done ? "Done" : "To go", value: done ? "100%" : whole(d.targetCents - d.balanceCents) }] },
      { type: "p", text: done ? "Nice work. You can stop setting money aside for it, or raise the target." : `Keep it up${d.targetDate ? `: you're aiming for ${d.targetDate}` : ""}.` },
    ],
    button: { label: d.kind === "goal" ? "See your goals" : "See your funds", url: d.kind === "goal" ? "/#/goals" : "/#/funds" },
  };
}

export function goalBehind(d: { name: string; balanceCents: number; expectedCents: number; targetCents: number; targetDate: string; monthlyCents: number }): EmailContent {
  return {
    ...base,
    subject: `${d.name} is falling behind`,
    preheader: `Save ${whole(d.monthlyCents)}/month to reach it by ${d.targetDate}.`,
    title: `${d.name} is behind schedule`,
    blocks: [
      { type: "stats", items: [{ label: "Saved", value: whole(d.balanceCents) }, { label: "On track would be", value: whole(d.expectedCents), tone: "warn" }, { label: "Target", value: whole(d.targetCents) }] },
      { type: "p", text: `To reach it by **${d.targetDate}**, plan about **${whole(d.monthlyCents)} a month** for it from now on, or move the date.` },
    ],
    button: { label: "See your goals", url: "/#/goals" },
  };
}

export function largePurchase(d: { thresholdCents: number; items: { merchant: string; cents: number; date: string; account?: string | null }[] }): EmailContent {
  const one = d.items.length === 1;
  return {
    ...base,
    subject: one ? `Large purchase: ${money(d.items[0].cents)} at ${d.items[0].merchant}` : `${d.items.length} large purchases`,
    preheader: `Over your ${whole(d.thresholdCents)} alert amount.`,
    title: one ? "A large purchase came in" : "Large purchases came in",
    blocks: [
      { type: "rows", rows: d.items.map((i) => ({ label: i.merchant, note: [i.date, i.account].filter(Boolean).join(" · "), value: money(i.cents) })) },
      { type: "p", text: `You get this for any purchase over ${whole(d.thresholdCents)}. If you don't recognize it, check with your bank.` },
    ],
    button: { label: "See transactions", url: "/#/budget" },
  };
}

export function nextMonthSetup(d: { monthName: string; startsIn: number }): EmailContent {
  return {
    ...base,
    subject: `Set up your ${d.monthName} budget`,
    preheader: `${d.monthName} starts in ${d.startsIn} day${d.startsIn === 1 ? "" : "s"}.`,
    title: `${d.monthName} starts in ${d.startsIn} day${d.startsIn === 1 ? "" : "s"}`,
    blocks: [
      { type: "p", text: `There's no budget for **${d.monthName}** yet. Make it now so every dollar has a job from day one. Copying this month takes one click.` },
    ],
    button: { label: `Make the ${d.monthName} budget`, url: "/#/budget" },
  };
}

export function newSignIn(d: { device: string; ip: string; when: string; how: string }): EmailContent {
  return {
    why: "You're getting this because new sign-in alerts are turned on in Settings › Notifications.",
    settingsPath: NOTIFY_SETTINGS,
    subject: `New sign-in: ${d.device}`,
    preheader: `Signed in with ${d.how} on ${d.when}.`,
    title: "New sign-in to your budget",
    blocks: [
      { type: "rows", rows: [{ label: "Device", value: d.device }, { label: "Signed in with", value: d.how }, { label: "When", value: d.when }, { label: "Network address", value: d.ip }] },
      { type: "callout", text: "**Was this you?** Then there's nothing to do. If not, sign that device out and change your password right away.", tone: "warn" },
    ],
    button: { label: "Review signed-in devices", url: "/#/settings/security" },
  };
}

export function monthlyInsights(d: {
  monthName: string;
  nextMonthName: string;
  intro?: string | null;
  focus?: string | null;
  aiService?: string | null;
  trends: { item: string; group: string; amounts: number[] }[];
  plan: { item: string; plannedCents: number; spent: number[]; suggestCents: number; direction: "more" | "less" }[];
  subscriptions: { merchant: string; cents: number; wasCents: number | null }[];
  wins: { underItems: { item: string; leftCents: number }[]; savingsRate: number | null; lastRate: number | null; goals: { name: string; addedCents: number; pct: number | null }[] };
}): EmailContent {
  const blocks: EmailContent["blocks"] = [];
  if (d.intro) blocks.push({ type: "p", text: d.intro });
  if (d.trends.length) blocks.push({ type: "rows", title: "Trending up", rows: d.trends.map((t) => ({ label: t.item, note: `${t.group} · ${t.amounts.map(whole).join(" → ")}`, value: `+${whole(t.amounts[2] - t.amounts[0])}`, tone: "bad" })) });
  if (d.plan.length)
    blocks.push({
      type: "rows",
      title: "Plan these differently",
      rows: d.plan.map((p) => ({ label: p.item, note: `Planned ${whole(p.plannedCents)}, spent ${p.spent.map(whole).join(", ")}`, value: `Plan ${whole(p.suggestCents)}`, tone: p.direction === "more" ? "warn" : "good" })),
    });
  if (d.subscriptions.length)
    blocks.push({
      type: "rows",
      title: "Subscriptions",
      rows: d.subscriptions.map((s) => (s.wasCents ? { label: s.merchant, note: `Price went up from ${money(s.wasCents)}`, value: money(s.cents), tone: "bad" as const } : { label: s.merchant, note: "New monthly charge", value: `${money(s.cents)}/mo`, tone: "warn" as const })),
    });
  const wins: string[] = [];
  if (d.wins.savingsRate !== null && d.wins.savingsRate > 0)
    wins.push(
      d.wins.lastRate !== null && d.wins.savingsRate > d.wins.lastRate
        ? `You saved **${d.wins.savingsRate}%** of your income, up from ${d.wins.lastRate}% the month before.`
        : `You saved **${d.wins.savingsRate}%** of your income.`
    );
  for (const u of d.wins.underItems) wins.push(`**${u.item}** came in ${whole(u.leftCents)} under plan.`);
  for (const g of d.wins.goals) wins.push(`**${g.name}** grew by ${whole(g.addedCents)}${g.pct !== null ? ` (now ${g.pct}% of the way)` : ""}.`);
  if (wins.length) {
    blocks.push({ type: "p", text: "**Wins**" });
    blocks.push({ type: "bullets", items: wins });
  }
  if (d.focus) blocks.push({ type: "callout", text: `**Focus for ${d.nextMonthName}:** ${d.focus}` });
  if (d.aiService) blocks.push({ type: "p", text: `The numbers come from your budget; ${d.aiService} wrote the wording. Check before acting on it.` });
  if (!blocks.length) blocks.push({ type: "p", text: "Nothing stood out this month: no rising trends, no plans that keep missing and no subscription changes." });
  return {
    ...base,
    subject: `Your ${d.monthName} insights`,
    preheader: d.focus ? `Focus for ${d.nextMonthName}: ${d.focus}` : `What stood out in ${d.monthName}.`,
    title: `What stood out in ${d.monthName}`,
    blocks,
    button: { label: "See your reports", url: "/#/reports" },
  };
}
