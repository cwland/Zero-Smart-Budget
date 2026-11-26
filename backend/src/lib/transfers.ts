import { sql } from "drizzle-orm";
import { transactions, transactionSplits } from "../db/schema.js";

// Transfer items hold money moved between your own accounts. It isn't spending, so reports,
// alerts and Month Wrap-Up leave them out. These conditions are shared so every query skips
// them the same way.

// For queries over transaction_splits: the split isn't on a transfer item
// (unassigned splits and income-item splits count as before).
export const notTransferSplit = sql`not exists (
  select 1 from line_items li
  where li.id = ${transactionSplits.lineItemId} and li.is_transfer
)`;

// For queries over whole transactions: false only when the transaction is assigned and
// every one of its splits is on a transfer item. Unassigned and partly-transfer transactions count.
export const notTransferTransaction = sql`not (
  exists (select 1 from transaction_splits s where s.transaction_id = ${transactions.id})
  and not exists (
    select 1 from transaction_splits s
    left join line_items li on li.id = s.line_item_id
    where s.transaction_id = ${transactions.id} and not coalesce(li.is_transfer, false)
  )
)`;
