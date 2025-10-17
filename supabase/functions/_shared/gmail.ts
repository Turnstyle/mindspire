export interface GmailMessageBody {
  data?: string;
  size?: number;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: GmailMessageBody;
  parts?: GmailMessagePart[];
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface MessagePayload {
  mimeType: string;
  body?: GmailMessageBody;
  parts?: GmailMessagePart[];
  headers?: GmailHeader[];
}

export function decodeBase64Url(input: string | undefined): string {
  if (!input) return "";

  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - normalized.length % 4) % 4;
  const padded = normalized.padEnd(normalized.length + padLength, "=");

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_error) {
    return "";
  }
}

function collectParts(
  parts: GmailMessagePart[] | undefined,
  predicate: (part: GmailMessagePart) => boolean,
): string[] {
  if (!parts?.length) return [];

  const results: string[] = [];
  const stack = [...parts];

  while (stack.length) {
    const part = stack.shift();
    if (!part) continue;

    if (predicate(part) && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (decoded.trim()) {
        results.push(decoded);
      }
    }

    if (part.parts?.length) {
      stack.push(...part.parts);
    }
  }

  return results;
}

export function extractPlainText(payload: MessagePayload): string {
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (decoded.trim()) return decoded;
  }

  const textParts = collectParts(
    payload.parts,
    (part) => part.mimeType === "text/plain",
  );

  if (textParts.length > 0) {
    return textParts[0];
  }

  if (payload.parts?.length) {
    return payload.parts
      .map((part) => part.body?.data ? decodeBase64Url(part.body.data) : "")
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function extractHtml(payload: MessagePayload): string {
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (decoded.trim()) return decoded;
  }

  const htmlParts = collectParts(
    payload.parts,
    (part) =>
      part.mimeType === "text/html" ||
      part.mimeType === "text/xhtml" ||
      part.mimeType === "application/xhtml+xml",
  );

  if (htmlParts.length > 0) {
    return htmlParts.join("\n\n");
  }

  return "";
}
