export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const body = await request.json();
    const question = body.question || "";
    const contexts = body.contexts || [];

    const sourceText = contexts
      .map((c, index) => `[${index + 1}] ${c.title}\n${c.text}\nURL: ${c.url}`)
      .join("\n\n");

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.XAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-3-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are an AUMA document assistant. Answer only from the provided sources. Cite source numbers."
          },
          {
            role: "user",
            content: `Question: ${question}\n\nSources:\n${sourceText}`
          }
        ]
      })
    });

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || "No answer returned.";

    return Response.json({ answer });
  }
};
