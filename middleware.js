// Vercel Edge Middleware — Basic Auth for all routes
// NOTE: This file must use ESM syntax (export default) regardless of package.json "type"

export default function middleware(request) {
  const authHeader = request.headers.get("authorization") || "";

  if (authHeader.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    const colon   = decoded.indexOf(":");
    const user    = decoded.slice(0, colon);
    const pass    = decoded.slice(colon + 1);

    if (
      user === process.env.BASIC_AUTH_USER &&
      pass === process.env.BASIC_AUTH_PASS
    ) {
      return; // allow
    }
  }

  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AUMA Demo"' },
  });
}

export const config = {
  matcher: ["/((?!_vercel|_next).*)"],
};
