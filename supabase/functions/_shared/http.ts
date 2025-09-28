export function jsonResponse(
  data: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, {
    ...init,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
