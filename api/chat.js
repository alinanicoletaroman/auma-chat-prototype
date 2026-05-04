module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  try {
    if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

    const { question = "", contexts = [], history = [], manualLang = "" } = req.body || {};

    const sourceText = contexts
      .map((c, i) =>
        `[${i + 1}] ${c.title}\nTyp: ${c.documentType || "–"}  |  Sprache: ${c.language || "–"}  |  Produkt: ${c.product || "–"}\n${c.text}\nURL: ${c.url}`
      )
      .join("\n\n---\n\n");

    const langInstruction = manualLang
      ? `The user has manually selected language: "${manualLang}". Prefer documents in that language and reply in that language.`
      : `Detect the language of the user's latest message and use that as the target language for both your reply and document recommendations.`;

    const systemPrompt = `You are a multilingual AUMA document assistant. AUMA manufactures electric actuators and gearboxes for industrial valves.

LANGUAGE RULE (mandatory):
- ${langInstruction}
- If the message is in English → reply in English.
- If in German → reply in German.
- If in French → reply in French. Apply the same rule for any other language.
- Mixed languages (e.g. mostly English with one German word): use the dominant language.
- Never switch language mid-conversation unless the user does first.

CLARIFICATION RULE:
- ONLY ask a clarifying question when BOTH conditions are true:
  (a) the user mentions a product/model name, AND
  (b) there is NO indication of document type anywhere in the message or conversation history (no words like certificate, zertifikat, manual, betriebsanleitung, technical data, technische daten, wiring, schaltplan, installation, datasheet, spare parts, quick guide, etc.)
- If the user already named the document type (even loosely, e.g. "product certificates", "operating manual", "wiring diagram"), do NOT ask for clarification – go straight to answering.
- When in doubt, attempt to answer rather than ask.
- In that case: write your question as plain text, and on the last line write exactly: CLARIFYING: true
- Do NOT show RANKED or LANG when asking a clarifying question.

ANSWER RULES (when sources are provided and intent is clear):
1. Recommend the most relevant document(s) from the provided sources. Prefer documents whose language matches the user's query language.
2. Explain briefly (1-2 sentences) why each recommended document matches.
3. Cite source numbers like [1], [2].
4. If none match well, say so honestly.
5. Be concise – max 4-6 sentences total.
6. Never invent content or URLs not in the sources.
7. At the very end, on two separate new lines, output ONLY:
RANKED: [most_relevant_number, second, third, ...]
LANG: <detected_language>
Where <detected_language> is the exact language label from the documents (e.g. English, Deutsch, Français, Español, Italiano, Polski, Nederlands, Русский, Svenska, Čeština, Magyar, Türkçe, 中文, 日本語).
Example:
RANKED: [3,1,5,2,4,6]
LANG: English`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:       "llama-3.3-70b-versatile",
        temperature: 0.15,
        max_tokens:  512,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: "user",   content: `Question: ${question}\n\nAvailable sources:\n${sourceText}` },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Groq API error");

    const raw          = data.choices?.[0]?.message?.content || "No answer returned.";
    const clarifying   = /CLARIFYING:\s*true/i.test(raw);
    const rankedMatch  = raw.match(/RANKED:\s*(\[[\d,\s]+\])/);
    const ranking      = rankedMatch ? JSON.parse(rankedMatch[1]) : null;
    const langMatch    = raw.match(/LANG:\s*([^\n]+)/);
    const detectedLang = langMatch ? langMatch[1].trim() : null;
    const answer       = raw
      .replace(/\nRANKED:\s*\[[\d,\s]+\]\s*$/m, "")
      .replace(/\nLANG:\s*[^\n]+/m, "")
      .replace(/\nCLARIFYING:\s*true\s*$/im, "")
      .trim();

    res.status(200).json({ answer, ranking, clarifying, detectedLang });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
