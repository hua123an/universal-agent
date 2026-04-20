export function truncate(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n... [truncated ${omitted} chars]`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
