export default function middleware(request) {
  const basicUser = process.env.BASIC_USER;
  const basicPass = process.env.BASIC_PASS;

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    const colon   = decoded.indexOf(":");
    const user     = decoded.slice(0, colon);
    const pass     = decoded.slice(colon + 1);
    if (user === basicUser && pass === basicPass) {
      return;
    }
  }

  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AUMA Chatbot"' },
  });
}

export const config = {
  matcher: "/(.*)",
};
