# Design Notes

Reference: the EveryDollar web app budget screen (everydollar.com/app/budget), Oct 2026,
measured from its live styles. Goal: same look, feel and density.
Cory's Dollar keeps its own name and logo, and doesn't copy theirs.

## Font

EveryDollar uses **Gibson** (`canada-type-gibson`), a paid Adobe font.
We use **Figtree** instead: free, similar rounded geometric shapes, bundled with the app
(`@fontsource/figtree`) so it works offline.

| Element | Size | Weight | Color |
|---|---|---|---|
| Month ("October") | 24px | 600 | text-base |
| Year ("2026") | 24px | 300 | text-subtle |
| Left-to-budget banner | 18px | 400, amount 500 | amount red/green |
| Group title ("Income", "Housing") | 16px | 600 | text-subtle |
| Column labels ("Planned", "Spent ▾") | 14px | 400 | text-subtle |
| Item name (editable input) | 18px | 400 | text-base |
| Planned amount (editable) | 18px | 400 | text-action (blue) |
| Spent / Remaining / Received | 16px | 400 | text-base |
| "Add Item" link | 16px | 400 | `#0091d9` |
| "Add Group" button | 16px | 600 | text-action |

## Color tokens

Copied from their theme variables (`--theme-*`). We'll use the same token names in Tailwind.

| Token | Hex | Use |
|---|---|---|
| bg-page | `#f5f7f8` | page background |
| bg-container | `#ffffff` | cards, left nav |
| bg-base | `#e8eced` | segmented control track |
| bg-strong | `#d5d9db` | progress bar track |
| bg-brand | `#35bd59` | brand green |
| bg-brand-subtle | `#eaf8ee` | green tint |
| bg-success | `#24a344` | progress fill, "zero-based" state |
| bg-error | `#cc392f` | overspent progress fill |
| bg-error-subtle | `#fdded8` | |
| bg-warning | `#faab19` | |
| bg-pressed | `#ebf4fa` | hover/pressed rows |
| bg-active | `#d8f1fc` | selected row |
| action-primary | `#003561` | primary buttons (navy) |
| action-primary-pressed | `#002342` | |
| action-tertiary / text-action | `#0073b9` | links, editable amounts, nav arrows |
| action-danger | `#cc392f` | delete |
| border-base | `#e8eced` | dividers |
| border-strong | `#d5d9db` | "Add Group" dotted border |
| border-form | `#69757a` | input borders |
| text-base | `#1f2426` | main text |
| text-subtle | `#495257` | labels, year |
| text-inactive | `#8e999e` | disabled |
| text-placeholder | `#69757a` | |
| text-error | `#cc392f` | "over budget" amount |

## Layout

```
┌────┬──────────────────────────────┬──────────────────────┐
│    │ October 2026 ▾          ‹ ›  │                      │  sticky header
│ L  │ ┌──────────────────────────┐ │   Summary rail       │
│ e  │ │  $172.91 over budget     │ │   [chart] [$] tabs   │  sticky banner card
│ f  │ └──────────────────────────┘ │                      │
│ t  │ ┌──────────────────────────┐ │   ( INCOME $6,985 )  │  donut chart
│    │ │ Income ^   Planned  Rec▾ │ │                      │
│ n  │ │ Paycheck 1  $3,240  $0   │ │  PLANNED SPENT REMAIN│  tabs
│ a  │ │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │ │  Housing $2,718 (39%)│  list by group,
│ v  │ │ Add Income      $6,985   │ │  Food    $1,105 (16%)│  each group colored
│    │ └──────────────────────────┘ │  ...                 │
│    │ ┌ Housing card ───────────┐ │                      │
│    │ ...                          │                      │
│    │ ┌┄┄┄┄┄ Add Group ┄┄┄┄┄┄┄┄┄┐ │                      │
└────┴──────────────────────────────┴──────────────────────┘
 56px   ~510px column                 ~510px (stacks under on narrow screens)
```

- **Left nav**: 56px wide, white, icon-only (Budget, Accounts, Goals, Insights, Settings, account initials at the bottom). The logo goes at the top.
- **Header** (sticky): "October **2026** ▾" title on the left; ‹ › month arrows in a small outlined button pair on the right; thin divider under it.
- **Summary banner** (sticky under the header): white card, 16px corners, soft shadow (`0 4px 12px rgba(31,36,38,0.06)`), ~46px tall, centered text:
  - "$172.91 **over budget**" with the amount in red
  - "$X **left to budget**" with the amount in green
  - "It's a zero-based budget!" with a check at $0 (EveryDollar's wording is "It's an EveryDollar budget!", so we use our own)
- **Group cards**: white, **16px corners**, no border or shadow, 24px gap between cards.
  - Header: padding 24px 24px 8px. Group name (with a collapse ^ caret) on the left, two column labels on the right: "Planned" and a **dropdown** ("Spent ▾" / "Remaining ▾"; for income "Received ▾"). That dropdown sets what the second column shows across the budget.
  - Rows: 58px tall, padding 0 24px. Name is an inline input that looks like plain text until focused. Planned is a blue inline input. Second column is plain text.
  - Under each row: a **4px progress bar** with 4px corners, gray `#d5d9db` track, green `#24a344` fill for spent ÷ planned, red `#cc392f` when overspent.
  - Footer: padding 16px 24px 24px. "Add Item" (or "Add Income") link on the left, group totals on the right.
  - Groups can be dragged to reorder, and there's a "Delete Group" action in the header.
- **Add Group**: a full-width button with a dotted gray border, 8px corners, 24px padding, blue semibold text.
- **Summary rail** (right): a white card with two tabs (a chart icon and a "$" icon; the $ tab is transactions).
  - Chart tab: a donut chart of planned spending by group, with the total income in the middle ("INCOME $6,985"). Below it, **PLANNED / SPENT / REMAINING** tabs and a list of groups with amount and % of income. Each group has its own color.
- **Responsive**: below ~1180px wide, the summary rail moves under the budget list.

## Not copied

- The EveryDollar name, logo, wordmark and "It's an EveryDollar budget!" phrase
- Gibson font (licensed)
- Ramsey-specific nav items (RamseyTrusted, Coaching, Ramsey+, My Feed)
