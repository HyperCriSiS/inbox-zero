import { getEmailUrlForMessage } from "@/utils/url";
import { isGoogleProvider } from "@/utils/email/provider-types";

type GetEmailMessageCellActionsOptions = {
  externalUrl?: string;
  hideViewEmailButton?: boolean;
  messageId: string;
  provider?: string;
  threadId: string;
  userEmail?: string | null;
};

export function getEmailMessageCellActions({
  externalUrl,
  hideViewEmailButton,
  messageId,
  provider,
  threadId,
  userEmail,
}: GetEmailMessageCellActionsOptions) {
  if (hideViewEmailButton) return null;

  const openUrl =
    externalUrl ||
    (isGoogleProvider(provider)
      ? getEmailUrlForMessage(messageId, threadId, userEmail, provider)
      : undefined);

  return {
    openUrl,
    showViewEmailButton: true,
  };
}
