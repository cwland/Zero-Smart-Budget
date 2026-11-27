export type Tab = "new" | "tracked" | "pending" | "deleted";

export const TAB_NAMES: Record<Tab, string> = { new: "New", tracked: "Assigned", deleted: "Deleted", pending: "Pending" };

// Only the tabs that need attention show a count.
const SHOWS_COUNT: Record<Tab, boolean> = { new: true, pending: true, tracked: false, deleted: false };

export function tabLabel(tab: Tab, count: number): string {
  return SHOWS_COUNT[tab] ? `${TAB_NAMES[tab]} (${count})` : TAB_NAMES[tab];
}
