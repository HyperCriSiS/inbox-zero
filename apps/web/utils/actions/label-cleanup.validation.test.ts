import { describe, expect, it } from "vitest";
import { saveLabelCleanupBody } from "./label-cleanup.validation";

const valid = {
  labelName: "News",
  afterDays: 30,
  action: "TRASH" as const,
};

describe("saveLabelCleanupBody", () => {
  it("accepts a label of the user's own", () => {
    expect(
      saveLabelCleanupBody.safeParse({ ...valid, labelId: "Label_12" }).success,
    ).toBe(true);
  });

  it.each([
    "INBOX",
    "SENT",
    "draft",
    "TRASH",
  ])("refuses the system label %s", (labelId) => {
    expect(saveLabelCleanupBody.safeParse({ ...valid, labelId }).success).toBe(
      false,
    );
  });
});
