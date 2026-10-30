# Design Notes

Zero Smart Budget's own look: a calm, dense budgeting screen built from simple cards, with
amounts you can edit in place. These are the sizes, colors and layout rules the app uses.

## Font

**Figtree**: free, rounded and easy to read at small sizes, bundled with the app
(`@fontsource/figtree`) so it works offline.

| Element | Size | Weight | Color |
|---|---|---|---|
| Month ("October") | 24px | 600 | ink |
| Year ("2026") | 24px | 300 | subtle |
| "Still to plan" banner | 18px | 400, amount 500 | amount red/green |
| Group title ("Income", "Home") | 16px | 600 | subtle |
| Column labels ("Planned", "Spent ▾") | 14px | 400 | subtle |
| Item name (editable) | 18px | 400 | ink |
| Planned amount (editable) | 18px | 400 | action |
| Spent / Remaining / Received | 16px | 400 | ink |
| "Add Item" link | 16px | 400 | link |
| "Add Group" button | 16px | 600 | action |

## Color tokens

Defined in `frontend/src/index.css` (`@theme`, holding the default theme's values) and used
through Tailwind classes (`bg-page`, `text-action`, ...). Themes in `frontend/src/themes.ts` set
the same tokens at runtime; pick one in Settings › Profile › Theme. Never hard-code a color in a
component: use a token, so every theme works.

| Theme | Logo (brand) | Buttons (primary) | Amounts (action) | Links |
|---|---|---|---|---|
| Harbor (default) | `#14a3a0` | `#0d3b45` | `#0b7a85` | `#0b8fa0` |
| Midnight & Coral | `#ff6b57` | `#1e1b4b` | `#4338ca` | `#4f46e5` |
| Plum & Amber | `#f0a500` | `#3d1f4f` | `#7b3fa0` | `#8e4bb8` |
| Terracotta & Sage | `#6f9f7c` | `#3e2a22` | `#b4532a` | `#c2410c` |
| Slate & Rose | `#f43f5e` | `#2b2d42` | `#be185d` | `#db2777` |

| Token | Use |
|---|---|
| page | page background |
| container | cards, side nav |
| line | dividers, segmented control track |
| strong | progress bar track, dotted "Add Group" border |
| brand / brand-subtle | logo, brand tint |
| success / success-subtle | progress fill, "zero-based" state |
| error / error-subtle | overspent, delete |
| warning | reminders |
| pressed / active | hovered and selected rows |
| primary / primary-pressed | main buttons, dark banners |
| action | editable amounts, arrows, secondary buttons |
| link | text links |
| ink / subtle / muted / inactive | text, from strongest to faintest |

Each theme also has its own group colors (the chart and the group list), used in order.
The logo, the sign-in lockup and the browser tab icon follow the theme's brand color; the files in
`frontend/public/brand` are fixed-color copies in the default theme.

## Layout

```
┌────┬──────────────────────────────┬──────────────────────┐
│    │ October 2026 ▾          ‹ ›  │                      │  sticky header
│ s  │ ┌──────────────────────────┐ │   Summary panel      │
│ i  │ │  $172.91 still to plan   │ │   [chart] [$] tabs   │  sticky banner card
│ d  │ └──────────────────────────┘ │                      │
│ e  │ ┌──────────────────────────┐ │   ( INCOME $6,985 )  │  donut chart
│    │ │ Income ^   Planned  Rec▾ │ │                      │
│ n  │ │ Paycheck    $3,240  $0   │ │  PLANNED SPENT REMAIN│  tabs
│ a  │ │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │ │  Home    $2,718 (39%)│  one row per group,
│ v  │ │ Add Income      $6,985   │ │  Food    $1,105 (16%)│  each in its color
│    │ └──────────────────────────┘ │  ...                 │
│    │ ┌ Home card ──────────────┐ │                      │
│    │ ...                          │                      │
│    │ ┌┄┄┄┄┄ Add Group ┄┄┄┄┄┄┄┄┄┐ │                      │
└────┴──────────────────────────────┴──────────────────────┘
 56px   ~510px column                 ~510px (stacks under on narrow screens)
```

- **Side nav**: 56px wide, white, icons only (Budget, Accounts, Funds, Goals, Settings), the account button and version at the bottom, the logo at the top.
- **Header** (sticky): "October **2026** ▾" on the left, ‹ › month arrows on the right, a thin divider under it.
- **Banner** (sticky under the header): a white card with 16px corners and a soft shadow, centered:
  - "$X **still to plan**" in green, "$X **planned beyond your income**" in red, or "Balanced! All of your income has a plan." with a check at $0.
- **Group cards**: white, 16px corners, no border, 24px apart.
  - Header: group name with a collapse caret; "Planned" and a dropdown ("Spent ▾" / "Remaining ▾", or "Received ▾" for income) that sets the second column everywhere.
  - Rows: 58px tall; the name and the planned amount are inline inputs that look like text until focused.
  - Under each row: a 4px progress bar (spent ÷ planned), red when over.
  - Footer: "Add Item" on the left, group totals on the right.
  - Groups and items drag to reorder.
- **Add Group**: a full-width button with a dotted border.
- **Summary panel** (right): a chart tab (a donut of planned spending by group, total income in the middle, Planned / Spent / Remaining tabs and a list of groups with amount and % of income) and a transactions tab.
- **Narrow screens**: below ~1180px wide, the summary panel moves under the budget; on phones the side nav becomes a bottom bar.
