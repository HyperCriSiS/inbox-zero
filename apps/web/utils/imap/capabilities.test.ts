import { describe, expect, it } from "vitest";
import { detectFeatures } from "@/utils/imap/capabilities";

function detect(overrides: Partial<Parameters<typeof detectFeatures>[0]> = {}) {
  return detectFeatures({
    capabilities: [],
    permanentFlags: [],
    folderPaths: [],
    ...overrides,
  });
}

describe("detectFeatures", () => {
  it("uses keywords when the server allows new ones", () => {
    expect(detect({ permanentFlags: ["\\Seen", "\\*"] }).labelStrategy).toBe(
      "keywords",
    );
  });

  it("uses label folders when keywords are unavailable", () => {
    expect(
      detect({ folderPaths: ["INBOX", "Labels", "Folders"] }).labelStrategy,
    ).toBe("folders");
  });

  it("does not take a lone Labels folder for label folders", () => {
    expect(detect({ folderPaths: ["INBOX", "Labels"] }).labelStrategy).toBe(
      "database",
    );
  });

  it("falls back to the database on a plain server", () => {
    expect(detect({ permanentFlags: ["\\Seen"] }).labelStrategy).toBe(
      "database",
    );
  });

  it("reads capabilities case-insensitively", () => {
    expect(detect({ capabilities: ["idle", "Qresync"] })).toMatchObject({
      idle: true,
      qresync: true,
      condstore: false,
    });
  });
});
