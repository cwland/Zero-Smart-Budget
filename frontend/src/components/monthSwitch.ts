import type { Budget } from "../api";

// Moving a transaction's date into another month: its items have to move to that month's items too
// (the server only accepts items from the transaction's own month). Items are matched by name:
// income items by name; budget items by group + name, or by name alone if only one item has it.
// "" (unassigned) when there's no clear match.

// A target is "l:<lineItemId>" for budget items, "i:<incomeItemId>" for income items
export function moveTarget(target: string, from: Budget, to: Budget): string {
  const [kind, idText] = target.split(":");
  const id = Number(idText);
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  if (kind === "i") {
    const name = from.income.find((i) => i.id === id)?.name;
    const match = name === undefined ? undefined : to.income.find((i) => same(i.name, name));
    return match ? `i:${match.id}` : "";
  }

  if (kind === "l") {
    const group = from.groups.find((g) => g.items.some((i) => i.id === id));
    const item = group?.items.find((i) => i.id === id);
    if (!group || !item) return "";
    const inGroup = to.groups.find((g) => same(g.name, group.name))?.items.find((i) => same(i.name, item.name));
    if (inGroup) return `l:${inGroup.id}`;
    const byName = to.groups.flatMap((g) => g.items).filter((i) => same(i.name, item.name));
    return byName.length === 1 ? `l:${byName[0].id}` : "";
  }

  return "";
}
