const fs   = require("fs");
const path = require("path");

const BATCH_SIZE  = 32;
const INDEX_PATH  = path.join(__dirname, "public", "auma-index.json");
const OUTPUT_PATH = path.join(__dirname, "public", "auma-vectors.json");

function docToText(doc) {
  return [doc.title, doc.product, doc.documentType, doc.language]
    .filter(Boolean)
    .join(" | ");
}

async function main() {
  const { pipeline } = await import("@xenova/transformers");

  console.log("Loading embedding model (downloads ~25 MB on first run)...");
  const embedder = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");

  const docs = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  console.log(`Embedding ${docs.length} documents...`);

  const vectors = [];
  let done = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch  = docs.slice(i, i + BATCH_SIZE);
    const texts  = batch.map(docToText);
    const output = await embedder(texts, { pooling: "mean", normalize: true });

    for (let j = 0; j < batch.length; j++) {
      vectors.push({ id: batch[j].id, vector: Array.from(output[j].data) });
    }

    done += batch.length;
    process.stdout.write(`\r${done} / ${docs.length}`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(vectors));
  console.log(`\nDone! Saved ${vectors.length} vectors to ${OUTPUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
