// Cory's Dollar database schema (Drizzle ORM)
// All money values are stored as integer cents ($10.50 = 1050).
// After changing this file run: npm run db:generate
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  email: text("email"), // used for password resets (and later, notifications)
  // Bumped to sign out every device: login tokens carry the version they were issued with
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// App-wide settings changed from the Settings page (e.g. "email"). Secrets inside are encrypted.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One-time password reset links. Only a hash of the token is stored.
export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Keys for other apps (n8n, Home Assistant, ...). Only a hash is stored.
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first characters, shown in the UI to identify the key
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// One budget per calendar month
export const budgetMonths = pgTable(
  "budget_months",
  {
    id: serial("id").primaryKey(),
    year: integer("year").notNull(),
    month: integer("month").notNull(), // 1-12
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budget_months_year_month_idx").on(t.year, t.month)]
);

// Planned income sources for a month (Paycheck 1, Side job, ...)
export const incomeItems = pgTable(
  "income_items",
  {
    id: serial("id").primaryKey(),
    monthId: integer("month_id")
      .notNull()
      .references(() => budgetMonths.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    plannedCents: integer("planned_cents").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("income_items_month_idx").on(t.monthId)]
);

// Category groups for a month (Housing, Food, ...)
export const categoryGroups = pgTable(
  "category_groups",
  {
    id: serial("id").primaryKey(),
    monthId: integer("month_id")
      .notNull()
      .references(() => budgetMonths.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("category_groups_month_idx").on(t.monthId)]
);

// Sinking funds persist across months.
// Balance = starting balance + planned on linked line items (up to this month) - spent on them
export const sinkingFunds = pgTable("sinking_funds", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  targetCents: integer("target_cents"),
  startingBalanceCents: integer("starting_balance_cents").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Budget line items inside a group (Rent, Groceries, ...)
export const lineItems = pgTable(
  "line_items",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => categoryGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    plannedCents: integer("planned_cents").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    sinkingFundId: integer("sinking_fund_id").references(() => sinkingFunds.id, {
      onDelete: "set null",
    }),
    favorite: boolean("favorite").notNull().default(false), // shown in the Favorites card too
  },
  (t) => [
    index("line_items_group_idx").on(t.groupId),
    index("line_items_fund_idx").on(t.sinkingFundId),
  ]
);

export const transactionType = pgEnum("transaction_type", ["expense", "income"]);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull(), // YYYY-MM-DD
    merchant: text("merchant").notNull(),
    // Cleaned-up merchant name used to match repeat merchants ("ACH CREDIT HOME DEPOT *4986 10/13" -> "home depot")
    merchantKey: text("merchant_key"),
    amountCents: integer("amount_cents").notNull(), // always positive; type gives direction
    type: transactionType("type").notNull().default("expense"),
    note: text("note"),
    // Imported from a bank through Plaid (null = typed in by hand)
    plaidTransactionId: text("plaid_transaction_id").unique(),
    plaidAccountId: text("plaid_account_id"),
    pending: boolean("pending").notNull().default(false), // not posted at the bank yet
    // Deleted transactions wait in the Deleted tab and can be restored. Their budget assignment is
    // set aside here (so budgets, funds and suggestions stop counting them) and put back on restore.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedSplits: jsonb("deleted_splits").$type<{ lineItemId: number | null; incomeItemId: number | null; amountCents: number }[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("transactions_date_idx").on(t.date), index("transactions_merchant_key_idx").on(t.merchantKey)]
);

// Links a transaction to line items (expenses) or income items (income).
// One split = normal transaction; several = split transaction; none = unassigned.
// If the linked item is deleted, the split stays but becomes unassigned.
export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: serial("id").primaryKey(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    lineItemId: integer("line_item_id").references(() => lineItems.id, { onDelete: "set null" }),
    incomeItemId: integer("income_item_id").references(() => incomeItems.id, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [
    index("splits_transaction_idx").on(t.transactionId),
    index("splits_line_item_idx").on(t.lineItemId),
    index("splits_income_item_idx").on(t.incomeItemId),
  ]
);

// Permanent history of money in and out of each sinking fund.
// Balance as of a month = starting balance + every entry dated on or before the end of that month.
//  - budgeted:   one per linked line item (planned amount), dated the 1st of its month
//  - spent:      one per (transaction, linked line item), negative, dated like the transaction
//  - adjustment: added by hand
// While an item is linked, its entries are kept in sync. If the item is unlinked or deleted,
// its entries stay as they were (history is never rewritten).
export const fundEntryKind = pgEnum("fund_entry_kind", ["budgeted", "spent", "adjustment"]);

export const fundEntries = pgTable(
  "fund_entries",
  {
    id: serial("id").primaryKey(),
    fundId: integer("fund_id")
      .notNull()
      .references(() => sinkingFunds.id, { onDelete: "cascade" }),
    kind: fundEntryKind("kind").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    amountCents: integer("amount_cents").notNull(), // + adds to the fund, - takes out
    description: text("description"),
    lineItemId: integer("line_item_id").references(() => lineItems.id, { onDelete: "set null" }),
    transactionId: integer("transaction_id").references(() => transactions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fund_entries_fund_date_idx").on(t.fundId, t.date),
    index("fund_entries_line_item_idx").on(t.lineItemId),
    index("fund_entries_transaction_idx").on(t.transactionId),
  ]
);

// ---------- Plaid bank connections ----------
// One row per bank login ("Item" in Plaid terms). The access token is encrypted.
export const plaidItemStatus = pgEnum("plaid_item_status", ["ok", "login_required", "error"]);

export const plaidItems = pgTable("plaid_items", {
  id: serial("id").primaryKey(),
  itemId: text("item_id").notNull().unique(),
  accessTokenEnc: text("access_token_enc").notNull(),
  env: text("env").notNull(), // "sandbox" | "production": tokens only work in the environment they came from
  institutionId: text("institution_id"),
  institutionName: text("institution_name").notNull(),
  status: plaidItemStatus("status").notNull().default("ok"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  cursor: text("cursor"), // where /transactions/sync left off
  importFrom: date("import_from", { mode: "string" }).notNull(), // skip bank history before this date
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Accounts inside a bank login (checking, savings, credit card, ...)
export const plaidAccounts = pgTable(
  "plaid_accounts",
  {
    id: serial("id").primaryKey(),
    plaidItemId: integer("plaid_item_id")
      .notNull()
      .references(() => plaidItems.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull().unique(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"), // last 4 digits
    type: text("type").notNull(), // depository, credit, loan, investment
    subtype: text("subtype"),
    importTransactions: boolean("import_transactions").notNull().default(true),
    currentBalanceCents: integer("current_balance_cents"),
    availableBalanceCents: integer("available_balance_cents"),
  },
  (t) => [index("plaid_accounts_item_idx").on(t.plaidItemId)]
);

// ---------- relations (for nested queries) ----------
export const budgetMonthsRelations = relations(budgetMonths, ({ many }) => ({
  incomeItems: many(incomeItems),
  groups: many(categoryGroups),
}));
export const incomeItemsRelations = relations(incomeItems, ({ one, many }) => ({
  month: one(budgetMonths, { fields: [incomeItems.monthId], references: [budgetMonths.id] }),
  splits: many(transactionSplits),
}));
export const categoryGroupsRelations = relations(categoryGroups, ({ one, many }) => ({
  month: one(budgetMonths, { fields: [categoryGroups.monthId], references: [budgetMonths.id] }),
  lineItems: many(lineItems),
}));
export const lineItemsRelations = relations(lineItems, ({ one, many }) => ({
  group: one(categoryGroups, { fields: [lineItems.groupId], references: [categoryGroups.id] }),
  sinkingFund: one(sinkingFunds, {
    fields: [lineItems.sinkingFundId],
    references: [sinkingFunds.id],
  }),
  splits: many(transactionSplits),
}));
export const sinkingFundsRelations = relations(sinkingFunds, ({ many }) => ({
  lineItems: many(lineItems),
  entries: many(fundEntries),
}));
export const fundEntriesRelations = relations(fundEntries, ({ one }) => ({
  fund: one(sinkingFunds, { fields: [fundEntries.fundId], references: [sinkingFunds.id] }),
}));
export const transactionsRelations = relations(transactions, ({ many }) => ({
  splits: many(transactionSplits),
}));
export const transactionSplitsRelations = relations(transactionSplits, ({ one }) => ({
  transaction: one(transactions, {
    fields: [transactionSplits.transactionId],
    references: [transactions.id],
  }),
  lineItem: one(lineItems, { fields: [transactionSplits.lineItemId], references: [lineItems.id] }),
  incomeItem: one(incomeItems, {
    fields: [transactionSplits.incomeItemId],
    references: [incomeItems.id],
  }),
}));
export const plaidItemsRelations = relations(plaidItems, ({ many }) => ({
  accounts: many(plaidAccounts),
}));
export const plaidAccountsRelations = relations(plaidAccounts, ({ one }) => ({
  item: one(plaidItems, { fields: [plaidAccounts.plaidItemId], references: [plaidItems.id] }),
}));
