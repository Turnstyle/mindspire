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
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(html, {
    ...init,
    headers,
  });
}

export function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url },
  });
}
