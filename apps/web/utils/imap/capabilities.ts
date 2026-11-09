export type ImapLabelStrategy = "keywords" | "folders" | "database";

export type ImapFeatures = {
  condstore: boolean;
  idle: boolean;
  labelStrategy: ImapLabelStrategy;
  objectId: boolean;
  qresync: boolean;
};

const LABEL_FOLDER_ROOT = /^labels$/i;
const CUSTOM_FOLDER_ROOT = /^folders$/i;

/**
 * Decided from what the server reports, never from its name, because the same
 * vendor can change backends. Proton Mail Bridge is covered by its `Labels`
 * folder: copying a message there is how it applies a label. It always lists
 * `Folders` next to it. Requiring both keeps an ordinary server, where a user
 * files real mail under a folder called Labels, from being treated like it:
 * removing a label deletes the copy in that folder.
 */
export function detectFeatures({
  capabilities,
  permanentFlags,
  folderPaths,
}: {
  capabilities: Iterable<string>;
  permanentFlags: Iterable<string> | undefined;
  folderPaths: readonly string[];
}): ImapFeatures {
  const supported = new Set(
    [...capabilities].map((capability) => capability.toUpperCase()),
  );

  return {
    condstore: supported.has("CONDSTORE"),
    idle: supported.has("IDLE"),
    objectId: supported.has("OBJECTID"),
    qresync: supported.has("QRESYNC"),
    labelStrategy: detectLabelStrategy(permanentFlags, folderPaths),
  };
}

function detectLabelStrategy(
  permanentFlags: Iterable<string> | undefined,
  folderPaths: readonly string[],
): ImapLabelStrategy {
  // `\*` in PERMANENTFLAGS means clients may create new keywords.
  if (permanentFlags && [...permanentFlags].includes("\\*")) return "keywords";
  if (
    folderPaths.some((path) => LABEL_FOLDER_ROOT.test(path)) &&
    folderPaths.some((path) => CUSTOM_FOLDER_ROOT.test(path))
  ) {
    return "folders";
  }
  return "database";
}
