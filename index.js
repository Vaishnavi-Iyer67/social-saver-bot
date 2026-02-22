// ----------------------------
// FIX FOR RAILWAY (Node 18)
// Add global File polyfill
// ----------------------------
if (typeof File === "undefined") {
  global.File = class File extends Blob {
    constructor(chunks, filename, options = {}) {
      super(chunks, options);
      this.name = filename;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const path = require("path");

const app = express();

// ================= GEMINI SETUP =================
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY missing");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ================= EXPRESS =================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static("public"));

// ================= DATABASE =================
// FIX ONLY THIS LINE ↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓
const db = new sqlite3.Database(
  path.join(__dirname, "data", "database.sqlite"),
  (err) => {
    if (err) console.error("❌ DB error:", err.message);
    else console.log("✅ SQLite connected");
  }
);
// ↑↑↑↑ YOUR ONLY REQUIRED FIX ↑↑↑↑


// ---------- TABLES ----------
db.run(`
CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    avatar_color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS main_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    main_category_id INTEGER,
    UNIQUE(name, main_category_id),
    FOREIGN KEY(main_category_id) REFERENCES main_categories(id)
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS saved_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    original_url TEXT,
    extracted_text TEXT,
    ai_summary TEXT,
    label_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(label_id) REFERENCES labels(id)
)
`);

// ================== AUTH MIDDLEWARE ==================
function requireAuth(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) return res.redirect("/login.html");

  db.get("SELECT phone FROM login_tokens WHERE token = ?", [token], (err, row) => {
    if (err || !row) return res.redirect("/login.html");
    req.userPhone = row.phone;
    next();
  });
}

// ================== STATIC PROTECTED ROUTES ==================
app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/dashboard.html"));
});
app.get("/all-posts", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/all-posts.html"));
});
app.get("/search", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/search.html"));
});
app.get("/analytics", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/analytics.html"));
});
app.get("/profile", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});

// ================== MAGIC LINK LOGIN ==================
app.post("/login-request", (req, res) => {
  const { phone } = req.body;

  if (!phone) return res.json({ error: "Phone required" });

  const token = crypto.randomBytes(30).toString("hex");

  db.run("INSERT INTO login_tokens (token, phone) VALUES (?, ?)", [token, phone]);

  const loginLink = `${process.env.APP_URL}/login?token=${token}`;

  return res.json({ loginLink });
});

app.get("/login", (req, res) => {
  const token = req.query.token;
  if (!token) return res.send("Invalid Token");

  db.get("SELECT phone FROM login_tokens WHERE token = ?", [token], (err, row) => {
    if (!row) return res.send("Invalid or expired token");

    res.cookie("auth_token", token, { httpOnly: true });

    db.get("SELECT phone FROM users WHERE phone = ?", [row.phone], (err, u) => {
      if (!u) {
        const colors = ["mint", "cream", "cocoa"];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];

        db.run(
          "INSERT INTO users (phone, name, avatar_color) VALUES (?, ?, ?)",
          [row.phone, "User " + row.phone.slice(-4), randomColor]
        );
      }
    });

    res.redirect("/dashboard");
  });
});

// ================== USER PROFILE API ==================
app.get("/api/me", requireAuth, (req, res) => {
  const phone = req.userPhone;

  db.get("SELECT * FROM users WHERE phone = ?", [phone], (err, user) => {
    if (!user) return res.json({ error: "User not found" });

    db.all(
      `
            SELECT mc.name AS category, COUNT(sp.id) AS total
            FROM saved_posts sp
            JOIN labels l ON sp.label_id = l.id
            JOIN main_categories mc ON l.main_category_id = mc.id
            WHERE sp.user_phone = ?
            GROUP BY mc.id
        `,
      [phone],
      (err, stats) => {
        res.json({ user, stats });
      }
    );
  });
});

// ================== RANDOM INSPIRATION ==================
app.get("/random-post", requireAuth, (req, res) => {
  db.get(
    `
        SELECT sp.*, mc.name AS category 
        FROM saved_posts sp
        JOIN labels l ON sp.label_id = l.id
        JOIN main_categories mc ON l.main_category_id = mc.id
        WHERE sp.user_phone = ?
        ORDER BY RANDOM()
        LIMIT 1
    `,
    [req.userPhone],
    (err, row) => {
      if (!row) return res.json({ error: "No posts saved" });
      res.json(row);
    }
  );
});

// ================== EXPORT PDF ==================
app.get("/export/pdf", requireAuth, (req, res) => {
  db.all(
    `
        SELECT sp.*, mc.name AS category 
        FROM saved_posts sp
        JOIN labels l ON sp.label_id = l.id
        JOIN main_categories mc ON l.main_category_id = mc.id
        WHERE sp.user_phone = ?
    `,
    [req.userPhone],
    (err, posts) => {
      const doc = new PDFDocument();
      res.setHeader("Content-Type", "application/pdf");
      doc.pipe(res);

      doc.fontSize(22).text("Your Saved Posts", { underline: true });
      doc.moveDown();

      posts.forEach((p) => {
        doc.fontSize(14).text(`Category: ${p.category}`);
        doc.text(`Summary: ${p.ai_summary}`);
        doc.text(`URL: ${p.original_url}`);
        doc.moveDown();
      });

      doc.end();
    }
  );
});

// ================== POSTS & ANALYTICS ==================
app.get("/posts/all", requireAuth, (req, res) => {
  db.all(
    `
        SELECT sp.id, sp.original_url, sp.ai_summary,
               l.name AS label, mc.name AS category, sp.created_at
        FROM saved_posts sp
        JOIN labels l ON sp.label_id = l.id
        JOIN main_categories mc ON l.main_category_id = mc.id
        WHERE sp.user_phone = ?
        ORDER BY sp.created_at DESC
    `,
    [req.userPhone],
    (err, rows) => res.json(rows)
  );
});

app.get("/analytics/categories", requireAuth, (req, res) => {
  db.all(
    `
        SELECT mc.name AS category, COUNT(sp.id) AS total_posts
        FROM main_categories mc
        LEFT JOIN labels l ON mc.id = l.main_category_id
        LEFT JOIN saved_posts sp ON sp.label_id = l.id AND sp.user_phone = ?
        GROUP BY mc.id
        ORDER BY total_posts DESC
    `,
    [req.userPhone],
    (err, rows) => res.json(rows)
  );
});

app.get("/analytics/trending", requireAuth, (req, res) => {
  db.all(
    `
        SELECT l.name AS label, mc.name AS category, COUNT(sp.id) AS total_posts
        FROM saved_posts sp
        JOIN labels l ON sp.label_id = l.id
        JOIN main_categories mc ON l.main_category_id = mc.id
        WHERE sp.user_phone = ?
        GROUP BY l.id
        ORDER BY total_posts DESC
        LIMIT 5
    `,
    [req.userPhone],
    (err, rows) => res.json(rows)
  );
});

// ================== SEARCH ==================
app.get("/search-api", requireAuth, (req, res) => {
  const q = `%${req.query.query}%`;

  db.all(
    `
        SELECT sp.*, l.name AS label, mc.name AS category
        FROM saved_posts sp
        JOIN labels l ON sp.label_id = l.id
        JOIN main_categories mc ON l.main_category_id = mc.id
        WHERE sp.user_phone = ?
          AND (sp.ai_summary LIKE ? OR l.name LIKE ? OR mc.name LIKE ?)
    `,
    [req.userPhone, q, q, q],
    (err, rows) => res.json(rows)
  );
});

// ================== AI ANALYZER & INSTAGRAM META ==================
async function analyzeWithGemini(text) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
Analyze:
"${text}"

1 sentence summary, 1 broad category, 1 short label.
JSON only:
{
"summary": "...",
"main_category": "...",
"label": "..."
}
`;

    let raw = (
      await model.generateContent(prompt)
    ).response
      .text()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(raw);
  } catch {
    return { summary: "Failed", main_category: "general", label: "general" };
  }
}

async function extractInstagramMetadata(url) {
  try {
    const html = (
      await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      })
    ).data;
    const $ = cheerio.load(html);
    return `${$('meta[property="og:title"]').attr("content") || ""} ${
      $('meta[property="og:description"]').attr("content") || ""
    }`;
  } catch {
    return null;
  }
}

// ================== WHATSAPP BOT ==================
app.post("/whatsapp", async (req, res) => {
  if (!req.body.Body) return res.sendStatus(200);

  const msg = req.body.Body;
  const from = req.body.From;

  // Login shortcut
  if (msg.trim().toUpperCase() === "LOGIN") {
    const token = crypto.randomBytes(30).toString("hex");
    db.run("INSERT INTO login_tokens (token, phone) VALUES (?, ?)", [
      token,
      from
    ]);

    const link = `${process.env.APP_URL}/login?token=${token}`;

    res.set("Content-Type", "text/xml");
    return res.send(
      `<Response><Message>Your login link:\n${link}</Message></Response>`
    );
  }

  // URL detection
  const urlMatch = msg.match(/https?:\/\/\S+/);
  let content = msg;

  if (urlMatch && urlMatch[0].includes("instagram.com")) {
    const meta = await extractInstagramMetadata(urlMatch[0]);
    content = meta?.length > 5 ? meta : "Instagram Post";
  }

  const { summary, main_category, label } = await analyzeWithGemini(content);

  // ensure user exists
  db.get("SELECT phone FROM users WHERE phone = ?", [from], (err, row) => {
    if (!row) {
      db.run(
        "INSERT INTO users (phone, name, avatar_color) VALUES (?, ?, ?)",
        [from, "User " + from.slice(-4), "mint"]
      );
    }
  });

  // ensure category
  db.get(
    "SELECT id FROM main_categories WHERE name = ?",
    [main_category],
    (err, cat) => {
      if (!cat) {
        db.run(
          "INSERT INTO main_categories (name) VALUES (?)",
          [main_category],
          function () {
            handleLabel(this.lastID);
          }
        );
      } else handleLabel(cat.id);
    }
  );

  function handleLabel(catId) {
    db.get(
      "SELECT id FROM labels WHERE name=? AND main_category_id=?",
      [label, catId],
      (err, lab) => {
        if (!lab) {
          db.run(
            "INSERT INTO labels (name, main_category_id) VALUES (?, ?)",
            [label, catId],
            function () {
              save(this.lastID);
            }
          );
        } else save(lab.id);
      }
    );
  }

  function save(labelId) {
    db.run(
      `
        INSERT INTO saved_posts (user_phone, original_url, extracted_text, ai_summary, label_id)
        VALUES (?, ?, ?, ?, ?)
        `,
      [from, msg, content, summary, labelId]
    );

    res.set("Content-Type", "text/xml");
    res.send(
      `<Response><Message>Saved under ${main_category} → ${label}\n${summary}</Message></Response>`
    );
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Running on port", PORT));