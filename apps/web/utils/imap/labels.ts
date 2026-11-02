const LABEL_FOLDER_PREFIX = /^labels[/.]/i;
const KEYWORD_PREFIX = "iz_";

/**
 * IMAP keywords are ASCII atoms, while label names hold spaces, slashes and
 * umlauts. Plain ASCII names stay readable as tags in other mail clients.
 */
export function labelToKeyword(label: string): string {
  const encoded = [...new TextEncoder().encode(label)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9-]/.test(char)
        ? char
        : `_${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");
  return `${KEYWORD_PREFIX}${encoded}`;
}

/** Foreign keywords, such as tags set in Thunderbird, pass through unchanged. */
export function keywordToLabel(keyword: string): string | null {
  if (keyword.startsWith("\\") || keyword.startsWith("$")) return null;
  if (!keyword.startsWith(KEYWORD_PREFIX)) return keyword;

  const encoded = keyword.slice(KEYWORD_PREFIX.length);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "_") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function isLabelFolder(path: string) {
  return LABEL_FOLDER_PREFIX.test(path);
}

/** Proton labels cannot nest, while Inbox Zero's own names contain slashes. */
export function toLabelFolderName(name: string) {
  return name.replaceAll("/", " - ");
}
