"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const FACEBOOK_API_VERSION = "v27.0";

const REQUEST_TIMEOUT_MS = 20000;
const GEMINI_TIMEOUT_MS = 60000;
const IMAGE_TIMEOUT_MS = 25000;

const MAX_NEWS_PER_SOURCE = 6;
const MAX_NEWS_TOTAL = 60;
const MAX_ARTICLE_AGE_HOURS = Number(process.env.MAX_ARTICLE_AGE_HOURS) || 72;
const MAX_DESCRIPTION_CHARS = 350;

const MIN_IMAGE_BYTES = 5 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const HISTORY_FILE = path.join("data", "history.json");
const HISTORY_LIMIT = 200;
const PUBLICATION_FILE = "publication.md";

const USER_AGENT =
  "Mozilla/5.0 (compatible; TechVisionAIAgent/2.0; +https://github.com/jacquesndjaleb-sys/techvision-ai-agent)";

// Une source inaccessible est simplement ignorée : n'hésitez pas à en ajouter.
const SOURCES = [
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Wired", url: "https://www.wired.com/feed/rss" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
  { name: "Numerama", url: "https://www.numerama.com/feed/" },
  { name: "Korben", url: "https://korben.info/feed" },
  { name: "Frandroid", url: "https://www.frandroid.com/feed" },
  { name: "TechCabal", url: "https://techcabal.com/feed/" }
];

// ---------------------------------------------------------------------------
// Utilitaires de texte et de XML
// ---------------------------------------------------------------------------

// Décode les entités HTML courantes. &amp; est traité en dernier pour éviter les doubles décodages.
function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function unwrapCdata(value) {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripTags(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

// Nettoie le HTML et les CDATA sans conserver les balises (y compris le HTML encodé en entités).
function cleanText(value = "") {
  let text = decodeEntities(stripTags(unwrapCdata(value)));
  if (/<\/?[a-z][^>]*>/i.test(text)) text = stripTags(text);
  return text.replace(/\s+/g, " ").trim();
}

function tagRegExp(tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, "i");
}

// Contenu texte d'une balise XML (sans HTML).
function extractTag(xml, tagName) {
  const match = xml.match(tagRegExp(tagName));
  return match ? cleanText(match[1]) : "";
}

// Contenu brut d'une balise, avec son HTML décodé (utile pour retrouver les <img>).
function extractRaw(xml, tagName) {
  const match = xml.match(tagRegExp(tagName));
  return match ? decodeEntities(unwrapCdata(match[1])) : "";
}

// Valeur d'un attribut dans une balise ouvrante.
function getAttr(tag, name) {
  const match = tag.match(new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeEntities(match[1] ?? match[2] ?? "").trim() : "";
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// ---------------------------------------------------------------------------
// Lecture des flux RSS / Atom
// ---------------------------------------------------------------------------

function extractLink(block) {
  // Atom : <link rel="alternate" href="..."/>
  for (const [, attrs] of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const href = getAttr(attrs, "href");
    const rel = getAttr(attrs, "rel");
    if (href && (!rel || rel === "alternate")) return href;
  }
  // RSS : <link>https://...</link>
  const link = extractTag(block, "link");
  if (/^https?:\/\//i.test(link)) return link;
  const guid = extractTag(block, "guid");
  return /^https?:\/\//i.test(guid) ? guid : "";
}

function isUsableImageUrl(url) {
  return (
    /^https?:\/\//i.test(url) &&
    !/(?:pixel|1x1|spacer|feedburner|doubleclick|\.svg(?:\?|$))/i.test(url)
  );
}

// Cherche une image dans un élément de flux (media:content, thumbnail, enclosure, <img>).
function extractFeedImage(block) {
  const candidates = [];

  for (const [tag] of block.matchAll(/<media:content\b[^>]*>/gi)) {
    const type = getAttr(tag, "type");
    const medium = getAttr(tag, "medium");
    const url = getAttr(tag, "url");
    if (url && (medium === "image" || type.startsWith("image/") || (!type && !medium))) {
      candidates.push(url);
    }
  }
  for (const [tag] of block.matchAll(/<media:thumbnail\b[^>]*>/gi)) {
    candidates.push(getAttr(tag, "url"));
  }
  for (const [tag] of block.matchAll(/<enclosure\b[^>]*>/gi)) {
    if (getAttr(tag, "type").startsWith("image/")) candidates.push(getAttr(tag, "url"));
  }

  const html = ["content:encoded", "description", "content", "summary"]
    .map(tag => extractRaw(block, tag))
    .join("\n");
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    candidates.push(getAttr(tag, "src"));
  }

  return candidates.find(isUsableImageUrl) || "";
}

function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => match[2]);

  return blocks
    .map(block => {
      const description =
        extractTag(block, "description") ||
        extractTag(block, "summary") ||
        extractTag(block, "content:encoded") ||
        extractTag(block, "content");
      const date =
        extractTag(block, "pubDate") ||
        extractTag(block, "published") ||
        extractTag(block, "updated") ||
        extractTag(block, "dc:date");

      return {
        source: source.name,
        title: extractTag(block, "title"),
        link: extractLink(block),
        description: truncate(description, MAX_DESCRIPTION_CHARS),
        date,
        timestamp: Date.parse(date) || 0,
        feedImage: extractFeedImage(block)
      };
    })
    .filter(item => item.title && /^https?:\/\//i.test(item.link));
}

async function getNews(source) {
  try {
    console.log(`Lecture de la source : ${source.name}`);

    const response = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);

    const news = parseFeed(await response.text(), source)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_NEWS_PER_SOURCE);

    console.log(`  → ${news.length} actualités (${news.filter(n => n.feedImage).length} avec image).`);
    return news;
  } catch (error) {
    console.error(`  → Source inaccessible (${source.name}) : ${error.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Historique (évite de republier la même actualité)
// ---------------------------------------------------------------------------

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history.slice(-HISTORY_LIMIT), null, 2)}\n`, "utf8");
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// Récupère l'image principale d'une page (og:image / twitter:image).
async function getPageImage(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);

    const html = (await response.text()).slice(0, 400000);
    const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);

    for (const key of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
      for (const meta of metas) {
        const name = (getAttr(meta, "property") || getAttr(meta, "name")).toLowerCase();
        const content = getAttr(meta, "content");
        if (name === key && content) return new URL(content, response.url || pageUrl).href;
      }
    }
  } catch (error) {
    console.log(`  Page de l'article illisible pour l'image : ${error.message}`);
  }
  return "";
}

async function downloadImage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.5"
    },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
  });

  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);

  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extensions = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif" };
  if (!extensions[type]) throw new Error(`format non pris en charge (${type || "inconnu"})`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < MIN_IMAGE_BYTES) throw new Error("image trop petite");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("image trop lourde");

  return { url, buffer, type, extension: extensions[type] };
}

// Essaie l'image de la page de l'article (souvent en haute résolution), puis celle du flux.
async function resolveImage(article) {
  const pageImage = await getPageImage(article.link);
  const candidates = [...new Set([pageImage, article.feedImage].filter(isUsableImageUrl))];

  for (const url of candidates) {
    try {
      const image = await downloadImage(url);
      console.log(`Image retenue (${Math.round(image.buffer.length / 1024)} Ko) : ${url}`);
      return image;
    } catch (error) {
      console.log(`Image ignorée (${url}) : ${error.message}`);
    }
  }

  console.log("Aucune image exploitable : la publication sera envoyée avec l'aperçu du lien.");
  return null;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

function isRetryable(error) {
  return (
    error.retryable === true ||
    [408, 429, 500, 502, 503, 504].includes(error.status) ||
    ["TimeoutError", "AbortError", "TypeError"].includes(error.name)
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    blocked: { type: "BOOLEAN" },
    reason: { type: "STRING" },
    article_id: { type: "INTEGER" },
    title: { type: "STRING" },
    body: { type: "STRING" },
    question: { type: "STRING" },
    hashtags: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["blocked", "reason", "article_id", "title", "body", "question", "hashtags"]
};

function buildPrompt(articles, recentSources) {
  const list = articles.map((article, id) => ({
    id,
    source: article.source,
    title: article.title,
    description: article.description,
    date: article.date,
    image_disponible: Boolean(article.feedImage)
  }));

  return `Tu es le rédacteur en chef d'une page Facebook spécialisée dans la technologie, l'informatique, l'intelligence artificielle et les innovations numériques. Les lecteurs sont francophones.

ACTUALITÉS DISPONIBLES (JSON) :
${JSON.stringify(list, null, 2)}

SOURCES UTILISÉES POUR LES DERNIÈRES PUBLICATIONS (à varier si l'intérêt est comparable) :
${recentSources.length ? recentSources.join(", ") : "aucune"}

RÈGLES DE FIABILITÉ :
1. Utilise exclusivement les faits explicitement présents dans le titre et la description de l'article choisi. Les autres articles ne servent pas à le compléter.
2. N'utilise aucune connaissance extérieure, aucune supposition et aucune déduction présentée comme un fait.
3. N'invente jamais de date, chiffre, statistique, citation, nom, fonction, événement, conséquence, cause, accusation ou réaction.
4. Respecte le degré de certitude de la source : une possibilité reste une possibilité, une annonce reste une annonce, une accusation n'est jamais un fait établi.
5. Si le sujet est confus, contradictoire ou trop mince pour rédiger sans extrapoler, réponds avec blocked = true et explique brièvement pourquoi dans reason. Dans ce cas, renseigne aussi article_id avec 0, title, body et question avec des chaînes vides, et hashtags avec un tableau vide. Si tu rédiges une publication, réponds avec blocked = false et renseigne tous les autres champs.
6. Choisis un seul article et ne fusionne jamais plusieurs actualités.
7. N'affirme pas avoir lu l'article complet : tu ne disposes que du titre et de la description.

RÈGLES ÉDITORIALES :
1. Écris en français naturel et clair, même si l'article est en anglais. Conserve les noms propres et les noms de produits.
2. Ton journalistique neutre, précis et accessible. Pas d'exagération ni de mots comme "incroyable", "choc", "révolution" ou "scandale" sauf si la source les justifie.
3. À qualité égale, préfère un article dont image_disponible vaut true, et une source différente de celles des dernières publications.
4. title : une phrase accrocheuse mais fidèle, 100 caractères maximum, sans émoji.
5. body : 2 à 4 phrases courtes (environ 250 à 600 caractères) qui commencent par l'information essentielle. N'invente aucun impact. N'inclus ni hashtag, ni lien, ni nom de source.
6. question : une question simple pour les lecteurs, sans présupposer de fait non confirmé.
7. hashtags : 3 à 5 hashtags précis, sans espace, sans sensationnalisme.
8. article_id : l'identifiant exact de l'article choisi.

Réponds uniquement avec l'objet JSON demandé.`;
}

function parseModelJson(text) {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const error = new Error("Gemini a retourné un JSON illisible.");
    error.retryable = true;
    throw error;
  }
}

async function askGemini(prompt, articleCount) {
  const models = [...new Set([MODEL, FALLBACK_MODEL])];
  const attemptsPerModel = 2;
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      try {
        console.log(`Tentative Gemini ${attempt}/${attemptsPerModel} avec le modèle ${model}...`);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.35,
                maxOutputTokens: 2048,
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA
              }
            }),
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
          }
        );

        const responseText = await response.text();
        let data;
        try {
          data = JSON.parse(responseText);
        } catch {
          const error = new Error(`Réponse Gemini illisible (HTTP ${response.status}).`);
          error.status = response.status;
          throw error;
        }

        if (!response.ok) {
          const error = new Error(data.error?.message || `Erreur HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }

        const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (!text) {
          const reason = data.candidates?.[0]?.finishReason;
          const error = new Error(`Gemini n'a retourné aucun texte${reason ? ` (raison : ${reason})` : ""}.`);
          error.retryable = true;
          throw error;
        }

        const result = parseModelJson(text);
        validateResult(result, articleCount);

        console.log(`Réponse valide reçue de ${model}.`);
        return result;
      } catch (error) {
        lastError = error;
        console.error(`Échec avec ${model}, tentative ${attempt} : ${error.message}`);

        if (!isRetryable(error)) throw error;

        if (attempt < attemptsPerModel) {
          const delay = attempt * 5000;
          console.log(`Nouvelle tentative dans ${delay / 1000} secondes...`);
          await sleep(delay);
        } else if (model !== models[models.length - 1]) {
          console.log(`Le modèle ${model} reste indisponible. Bascule vers le modèle de secours.`);
        }
      }
    }
  }

  throw new Error(
    `Tous les modèles Gemini sont temporairement indisponibles. Dernière erreur : ${lastError?.message || "inconnue"}`
  );
}

function validateResult(result, articleCount) {
  const fail = message => {
    const error = new Error(`Réponse Gemini invalide : ${message}`);
    error.retryable = true;
    throw error;
  };

  if (!result || typeof result !== "object") fail("objet attendu.");
  if (result.blocked === true) return;

  if (!Number.isInteger(result.article_id) || result.article_id < 0 || result.article_id >= articleCount) {
    fail("article_id hors limites.");
  }
  for (const field of ["title", "body", "question"]) {
    if (typeof result[field] !== "string" || !result[field].trim()) fail(`champ "${field}" manquant.`);
  }
}

function formatHashtags(hashtags = []) {
  const tags = hashtags
    .map(tag => String(tag).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .map(tag => `#${tag}`);
  return [...new Set(tags)].slice(0, 5).join(" ");
}

// Le lien et le nom de la source viennent du flux, jamais du modèle : ils sont donc toujours exacts.
function buildPost(result, article) {
  return [
    result.title.trim(),
    result.body.trim(),
    result.question.trim(),
    formatHashtags(result.hashtags),
    `Source : ${article.source} — ${article.link}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

async function facebookRequest(endpoint, body) {
  const response = await fetch(
    `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${endpoint}`,
    { method: "POST", body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) }
  );

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Réponse Facebook illisible (HTTP ${response.status}).`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Erreur Facebook HTTP ${response.status}.`);
  }
  return data;
}

async function publishToFacebook(post, article, image) {
  if (process.env.FACEBOOK_AUTO_PUBLISH !== "true") {
    console.log("Publication Facebook désactivée : le contenu reste enregistré en brouillon.");
    return null;
  }

  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error(
      "Configuration Facebook incomplète : ajoute FB_PAGE_ID et FB_PAGE_ACCESS_TOKEN dans les secrets GitHub."
    );
  }

  if (image) {
    try {
      const form = new FormData();
      form.append("message", post);
      form.append("access_token", token);
      form.append("source", new Blob([image.buffer], { type: image.type }), `techvision.${image.extension}`);

      const data = await facebookRequest(`${encodeURIComponent(pageId)}/photos`, form);
      const id = data.post_id || data.id;
      if (!id) throw new Error("Facebook n'a pas confirmé la création de la photo.");

      console.log(`Publication avec image envoyée sur Facebook. Identifiant : ${id}`);
      return id;
    } catch (error) {
      console.error(`Envoi de l'image impossible (${error.message}). Publication sans image, avec aperçu du lien.`);
    }
  }

  const body = new URLSearchParams({ message: post, link: article.link, access_token: token });
  const data = await facebookRequest(`${encodeURIComponent(pageId)}/feed`, body);
  if (!data.id) throw new Error("Facebook n'a pas confirmé la création de la publication.");

  console.log(`Publication avec aperçu du lien envoyée sur Facebook. Identifiant : ${data.id}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Sorties (fichiers et résumé GitHub Actions)
// ---------------------------------------------------------------------------

function cleanOldOutputs() {
  for (const file of fs.readdirSync(".")) {
    if (/^publication-image\./.test(file)) fs.rmSync(file, { force: true });
  }
}

function saveOutputs(post, article, image) {
  cleanOldOutputs();

  const lines = [post, "", "---"];
  if (article) lines.push(`Article : ${article.link}`);
  if (image) lines.push(`Image : ${image.url}`);
  fs.writeFileSync(PUBLICATION_FILE, `${lines.join("\n")}\n`, "utf8");

  if (image) fs.writeFileSync(`publication-image.${image.extension}`, image.buffer);
}

function writeStepSummary(post, image, facebookId) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const status = facebookId
    ? `Publié sur Facebook (id ${facebookId})`
    : "Brouillon (non publié sur Facebook)";
  const summary = [
    "## TechVision AI Agent",
    "",
    `**Statut :** ${status}`,
    image ? `**Image :** ${image.url}` : "**Image :** aucune",
    "",
    "```",
    post,
    "```",
    ""
  ].join("\n");

  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch {
    // Le résumé est facultatif.
  }
}

// ---------------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------------

async function main() {
  console.log("======================================");
  console.log("TECHVISION AI AGENT");
  console.log("Démarrage du système...");
  console.log("======================================");

  if (!API_KEY) {
    throw new Error("La clé GEMINI_API_KEY est absente. Vérifie les variables d'environnement.");
  }

  console.log(`\nÉtape 1 : Lecture de ${SOURCES.length} sources...`);
  const results = await Promise.all(SOURCES.map(getNews));
  const allNews = results.flat();
  const activeSources = results.filter(list => list.length > 0).length;

  if (allNews.length === 0) {
    throw new Error("Aucune actualité n'a pu être récupérée. Vérifie les flux RSS et la connexion réseau.");
  }
  console.log(`\nTotal : ${allNews.length} actualités issues de ${activeSources} sources.`);

  const history = loadHistory();
  const seenLinks = new Set(history.map(entry => entry.link));
  const seenTitles = new Set(history.map(entry => normalizeTitle(entry.title || "")));
  const oldestAllowed = Date.now() - MAX_ARTICLE_AGE_HOURS * 3600 * 1000;

  const unique = new Map();
  for (const item of allNews) {
    const key = normalizeTitle(item.title);
    const tooOld = item.timestamp && item.timestamp < oldestAllowed;
    if (tooOld || seenLinks.has(item.link) || seenTitles.has(key)) continue;
    if (!unique.has(item.link)) unique.set(item.link, item);
  }

  // Mélange équitable des sources : on alterne au lieu de laisser une source dominer la liste.
  const bySource = new Map();
  for (const item of unique.values()) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }
  const articles = [];
  for (let round = 0; articles.length < MAX_NEWS_TOTAL; round++) {
    let added = false;
    for (const list of bySource.values()) {
      if (list[round] && articles.length < MAX_NEWS_TOTAL) {
        articles.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }

  if (articles.length === 0) {
    console.log("\nAucune nouvelle actualité à publier (tout a déjà été traité récemment). Fin sans erreur.");
    return;
  }
  console.log(`${articles.length} actualités nouvelles envoyées à Gemini.`);

  console.log("\nÉtape 2 : Choix et rédaction par Gemini...");
  const recentSources = history.slice(-5).map(entry => entry.source).filter(Boolean);
  const result = await askGemini(buildPrompt(articles, recentSources), articles.length);

  if (result.blocked) {
    const message = `PUBLICATION BLOQUÉE : informations insuffisantes ou à vérifier auprès de la source.${
      result.reason ? ` (${result.reason})` : ""
    }`;
    saveOutputs(message, null, null);
    console.log(`\n${message}`);
    console.log("Publication Facebook annulée : rien n'a été envoyé.");
    return;
  }

  const article = articles[result.article_id];
  console.log(`\nArticle choisi : [${article.source}] ${article.title}`);

  console.log("\nÉtape 3 : Recherche de l'image...");
  const image = await resolveImage(article);

  const post = buildPost(result, article);
  saveOutputs(post, article, image);

  console.log("\nÉtape 4 : Publication Facebook...");
  const facebookId = await publishToFacebook(post, article, image);

  history.push({
    link: article.link,
    title: article.title,
    source: article.source,
    date: new Date().toISOString(),
    published: Boolean(facebookId)
  });
  saveHistory(history);
  writeStepSummary(post, image, facebookId);

  console.log("\n======================================");
  console.log("PUBLICATION PRÉPARÉE");
  console.log("======================================\n");
  console.log(post);
  console.log("\n======================================");
  console.log(`SUCCÈS ! Publication enregistrée dans ${PUBLICATION_FILE}`);
  console.log("======================================");
}

module.exports = { main, parseFeed, extractFeedImage, buildPost, formatHashtags, decodeEntities, validateResult };

if (require.main === module) {
  main().catch(error => {
    console.error("\n======================================");
    console.error("ÉCHEC DE TECHVISION AI AGENT");
    console.error("======================================");
    console.error(error.message);
    process.exitCode = 1;
  });
}
