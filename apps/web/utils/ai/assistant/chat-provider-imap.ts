import { googleChatProviderConfig } from "./chat-provider-google";
import type { AssistantChatProviderConfig } from "./chat-provider-shared";

// IMAP accounts use labels like Gmail, but their search is plain IMAP SEARCH.
// Gmail operators it does not know would be searched as text and find nothing.
export const imapChatProviderConfig: AssistantChatProviderConfig = {
  ...googleChatProviderConfig,
  searchSyntaxPolicy: `Provider search syntax:
- Supported operators: from:, to:, subject:, is:unread, is:read, is:starred, has:attachment, after:YYYY-MM-DD, and before:YYYY-MM-DD. Convert relative ages to a concrete date first.
- Any other words are matched together as one exact phrase, so keep free text to a single word or short phrase.
- Do not use Gmail-specific operators such as in:, label:, category:, newer_than:, older_than:, OR, or a leading minus. A search covers the inbox.`,
  inboxTriagePolicy: `Provider inbox defaults:
- For inbox triage, default to \`is:unread\` unless the user asks to include read messages.
- For retroactive cleanup sampling, single keywords like "newsletter" or "unsubscribe" are useful.`,
};
