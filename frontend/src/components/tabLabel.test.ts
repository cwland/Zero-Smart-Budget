import { describe, expect, it } from "vitest";
import { tabLabel } from "./tabLabel";

describe("tabLabel: transaction tab names", () => {
  it("shows the count for New and Pending", () => {
    expect(tabLabel("new", 5)).toBe("New (5)");
    expect(tabLabel("pending", 2)).toBe("Pending (2)");
  });
  it("leaves the count off Assigned and Deleted", () => {
    expect(tabLabel("tracked", 42)).toBe("Assigned");
    expect(tabLabel("deleted", 3)).toBe("Deleted");
  });
});
