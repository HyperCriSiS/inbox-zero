export function isGoogleProvider(
  provider: string | null | undefined,
): provider is "google" {
  return provider === "google";
}

export function isMicrosoftProvider(
  provider: string | null | undefined,
): provider is "microsoft" {
  return provider === "microsoft";
}

export function isImapProvider(
  provider: string | null | undefined,
): provider is "imap" {
  return provider === "imap";
}

/** Providers with a real folder tree, where MOVE_FOLDER is meaningful. */
export function supportsFolders(provider: string | null | undefined) {
  return isMicrosoftProvider(provider) || isImapProvider(provider);
}

/** Calendar connections only: a CalDAV server linked with a password. */
export function isCalDavProvider(
  provider: string | null | undefined,
): provider is "caldav" {
  return provider === "caldav";
}
