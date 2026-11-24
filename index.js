const fs = require("fs");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const SOURCES = [
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.theverge.com/rss/index.xml"
];

async function getNews(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "TechVisionAIAgent/1.0" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status}`);
    }

    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    return items.slice(0, 10).map(match => {
      const item = match[1];

      const extract = tag => {
        const result = item.match(
          new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
        );

        return result
          ? result[1]
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
              .replace(/<[^>]*>/g, "")
              .replace(/&amp;/g, "&")
              .trim()
          : "";
      };

      return {
        title: extract("title"),
        link: extract("link"),
        description: extract("description"),
        date: extract("pubDate")
      };
    }).filter(item => item.title && item.link);

  } catch (error) {
    console.error("Source inaccessible :", url, error.message);
    return [];
  }
}

async function generatePublication(news) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
Tu es le rédacteur en chef d'une page Facebook technologique.

Voici les actualités disponibles :
${JSON.stringify(news, null, 2)}

Ta mission :
1. Choisis le sujet le plus intéressant.
2. Utilise uniquement les informations présentes dans les sources.
3. Ne présente pas une information non vérifiée comme un fait.
4. Rédige une publication en français naturel.
5. Ajoute un titre accrocheur.
6. Explique le sujet simplement.
7. Ajoute une question pertinente.
8. Ajoute quelques hashtags.

Retourne uniquement la publication et indique la source utilisée.
`
          }]
        }]
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Erreur Gemini : ${JSON.stringify(data.error || data)}`
    );
  }

  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("\n") || "";
}

async function main() {
  if (!API_KEY) {
    throw new Error("La clé GEMINI_API_KEY est absente.");
  }

  console.log("🤖 TechVision AI Agent démarre...");

  const results = await Promise.all(
    SOURCES.map(getNews)
  );

  const news = results.flat();

  if (news.length === 0) {
    throw new Error("Aucune actualité récupérée.");
  }

  console.log(`${news.length} actualités récupérées.`);

  const publication = await generatePublication(news);

  if (!publication.trim()) {
    throw new Error("Gemini n'a généré aucune publication.");
  }

  fs.writeFileSync(
    "publication.md",
    publication,
    "utf8"
  );

  console.log("\nPUBLICATION PRÉPARÉE :\n");
  console.log(publication);
  console.log("\nPublication enregistrée dans publication.md");
}

main().catch(error => {
  console.error("ÉCHEC DE L'AGENT :", error);
  process.exitCode = 1;
});
