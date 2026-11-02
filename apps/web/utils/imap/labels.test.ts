import { describe, expect, it } from "vitest";
import {
  isLabelFolder,
  keywordToLabel,
  labelToKeyword,
} from "@/utils/imap/labels";

describe("label keywords", () => {
  it.each([
    "Newsletter",
    "Inbox Zero/Archived",
    "Rechnungen für 2026",
    "under_score",
  ])("round-trips %s through a valid atom", (label) => {
    const keyword = labelToKeyword(label);

    expect(keyword).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keywordToLabel(keyword)).toBe(label);
  });

  it("keeps tags set by other clients", () => {
    expect(keywordToLabel("project-x")).toBe("project-x");
  });

  it("hides system flags and keywords", () => {
    expect(keywordToLabel("\\Seen")).toBeNull();
    expect(keywordToLabel("$Forwarded")).toBeNull();
  });
});

describe("isLabelFolder", () => {
  it("recognizes both hierarchy delimiters", () => {
    expect(isLabelFolder("Labels/Work")).toBe(true);
    expect(isLabelFolder("Labels.Work")).toBe(true);
    expect(isLabelFolder("Labelsmith")).toBe(false);
  });
});
