// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SieveRuleDialog } from "./SieveRuleDialog";

const { suggest } = vi.hoisted(() => ({
  suggest: vi.fn(async () => ({
    data: {
      suggestions: [
        {
          id: "from",
          label: "Sender news@example.com",
          condition: {
            kind: "address",
            header: "from",
            match: "is",
            value: "news@example.com",
          },
        },
      ],
      folders: ["INBOX", "Newsletters"],
    },
  })),
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/utils/actions/sieve", () => ({
  suggestSieveRuleAction: suggest,
  planSieveRuleAction: vi.fn(),
  applySieveRuleAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SieveRuleDialog", () => {
  it("asks the Sieve server for suggestions once when it opens", async () => {
    render(
      <SieveRuleDialog
        emailAccountId="account-1"
        messageId="message-1"
        canApply={false}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(await screen.findByText("Sender news@example.com")).toBeTruthy();
    // Give a render loop the chance to fire again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});
