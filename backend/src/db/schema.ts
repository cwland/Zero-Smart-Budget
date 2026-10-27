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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
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
    amountCents: integer("amount_cents").notNull(), // always positive; type gives direction
    type: transactionType("type").notNull().default("expense"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("transactions_date_idx").on(t.date)]
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
