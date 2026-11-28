// A conversation page is mostly tool output the chat never shows (file dumps, base64 screenshots), and each
// result is also repeated in `toolUseResult`. Trim both so opening a long conversation transfers the
// conversation, not everything its tools ever printed.
const RESULT_LIMIT = 4000;

type Result = { content?: unknown; isError?: unknown; toolUseResult?: unknown };

function shorten(value: unknown) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/"base64":"[A-Za-z0-9+/=]{200,}"/g, '"base64":"…"');
  return text.length > RESULT_LIMIT ? text.slice(0, RESULT_LIMIT) + `\n…（已省略 ${(text.length - RESULT_LIMIT).toLocaleString()} 字）` : text;
}

/** Returns the history payload with oversized tool results trimmed; everything else is passed through. */
export function slimHistory<T>(data: T): T {
  const page = data as { messages?: unknown };
  if (!page || !Array.isArray(page.messages)) return data;
  const messages = page.messages.map(message => {
    const result = (message as { toolResult?: Result } | null)?.toolResult;
    if (!result || typeof result !== 'object') return message;
    const { toolUseResult: _repeated, ...rest } = result;
    return { ...(message as object), toolResult: { ...rest, content: shorten(rest.content) } };
  });
  return { ...page, messages } as T;
}
