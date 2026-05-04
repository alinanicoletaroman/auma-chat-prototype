const fs = require("fs");

const BASE_URL = "https://auma.com/de_DE/documents-funnel-api";

function flattenResults(results) {
  const docs = [];

  for (const groupName of Object.keys(results || {})) {
    for (const item of results[groupName]) {
      docs.push({
        id: item.id,
        title: item.title,
        language: item.language,
        langISO: item.langISO,
        documentType: item.type,
        fileMimeType: item.fileMimeType,
        fileSize: item.fileSize,
        url: item.url,
        product: item.asset || "",
        docId: item.docId || "",
        text: [
          item.title,
          item.type,
          item.language,
          item.asset || "",
          item.docId || ""
        ].join(" ")
      });
    }
  }

  return docs;
}

async function main() {
  let allDocs = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}?page=${page}&_=${Date.now()}`;
    console.log("Loading:", url);

    const response = await fetch(url);
    const data = await response.json();

    const docs = flattenResults(data.results);
    console.log(`Page ${page}: ${docs.length} docs`);

    if (docs.length === 0) break;

    allDocs.push(...docs);

    if (allDocs.length >= data.total) break;

    page++;
  }

  fs.writeFileSync(
    "public/auma-index.json",
    JSON.stringify(allDocs, null, 2),
    "utf8"
  );

  console.log(`Saved ${allDocs.length} documents.`);
}

main();