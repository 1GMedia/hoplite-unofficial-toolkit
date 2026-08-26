const SENSITIVE_KEY_PATTERN = '(?:(?:access|refresh|id)?[_-]?token|password|api[_-]?key|secret|client[_-]?secret|credential|login[_-]?url)';
const QUOTED_SENSITIVE_KEY_PATTERN = `(?:${SENSITIVE_KEY_PATTERN}|authorization)`;
const QUOTED_SENSITIVE_ASSIGNMENT_RE = new RegExp(
  `((?:["']?)${QUOTED_SENSITIVE_KEY_PATTERN}(?:["']?)\\s*[:=]\\s*)(["'])(?!\\[(?:redacted|url)\\]\\2)(?:\\\\.|(?!\\2)[^\\\\])*\\2`,
  'gi',
);
// Keep whitespace outside the placeholder lookahead so `\s*` cannot
// backtrack and reinterpret `Bearer [redacted]` as two separate values.
const AUTHORIZATION_VALUE_RE = /(authorization["']?\s*[:=])(?!(?:\s*)["']?(?:(?:bearer|basic)\s+)?\[(?:redacted|url)\]["']?)(\s*)(["']?)(?:(?:bearer|basic)\s+)?[^\s"',}\]]+\3/gi;
const STANDALONE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SENSITIVE_ASSIGNMENT_RE = new RegExp(
  `(${SENSITIVE_KEY_PATTERN}["']?\\s*[:=]\\s*)(?!\\[(?:redacted|url)\\])[^\\s"',}\\]]+`,
  'gi',
);

/** Redact credential-shaped text and URLs before it reaches a CLI result. */
export function redactText(input: string): string {
  return input
    .replace(QUOTED_SENSITIVE_ASSIGNMENT_RE, '$1$2[redacted]$2')
    .replace(AUTHORIZATION_VALUE_RE, '$1$2$3[redacted]$3')
    .replace(STANDALONE_BEARER_RE, 'Bearer [redacted]')
    .replace(SENSITIVE_ASSIGNMENT_RE, '$1[redacted]')
    .replace(/https?:\/\/[^\s)\]}>]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join('[redacted]');
  }
  return redactText(output);
}

/** Redact first, then bound. Truncation metadata never describes secret size. */
export function redactAndBound(input: string, maximum: number): {
  value: string;
  truncated: boolean;
} {
  const redacted = redactText(input);
  return {
    value: redacted.slice(0, maximum),
    truncated: redacted.length > maximum,
  };
}

export function safeBoundedString(input: string, maximum: number): string {
  return redactAndBound(input, maximum).value;
}
