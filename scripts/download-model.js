const path = require("path");

// @xenova/transformers is ESM-only — use dynamic import()
(async () => {
  const { pipeline, env } = await import("@xenova/transformers");

  env.cacheDir          = path.join(__dirname, "..", "model-cache");
  env.allowRemoteModels = true;

  console.log("Downloading embedding model to model-cache/ ...");
  await pipeline(
    "feature-extraction",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    { quantized: true }
  );
  console.log("Model downloaded successfully.");
  process.exit(0);
})().catch(err => {
  console.error("Model download failed:", err.message);
  process.exit(1);
});
