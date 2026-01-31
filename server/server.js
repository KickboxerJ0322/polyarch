import express from "express";

// server/server.js（先頭のimport群に追加）
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// __dirname相当を作る（ESM対応）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.resolve(__dirname, "../public");
app.use(express.static(PUBLIC_DIR));

// ★ 環境変数で入れる（ブラウザに出さない）
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

import cookieParser from "cookie-parser";
import crypto from "crypto";

app.use(cookieParser());

// sessionId をcookieで付与
function getSessionId(req, res) {
  let sid = req.cookies?.polyarch_sid;
  if (!sid) {
    sid = crypto.randomUUID();
    // 30日保持（任意）
    res.cookie("polyarch_sid", sid, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  }
  return sid;
}

// インメモリ会話ストア（Cloud Runはインスタンス変わると消える）
const chatStore = new Map(); // sid -> [{role:"user"|"assistant", content:"..."}]

// 10往復=20メッセージに丸める
function clampHistory(arr) {
  const MAX = 20; // 10往復
  if (arr.length <= MAX) return arr;
  return arr.slice(arr.length - MAX);
}

if (!GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is not set. Set env var before starting.");
}

// CORS（index.html を別ポートで開くため）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/**
 * POST /resolve-place
 * body: { "place": "東京ドーム" }
 * resp: { "lat": 35..., "lng": 139... }
 */
app.post("/resolve-place", async (req, res) => {
  try {
    const place = String(req.body?.place ?? "").trim();
    if (!place) return res.status(400).json({ error: "place is required" });

    const prompt = `
次の地名について、緯度(lat)・経度(lng)を返してください。

【重要】
- 出力は必ず JSON のみ
- 前後に説明文・文章・コードブロック（\`\`\`）を付けない
- 日本語での説明は禁止

地名: ${place}

出力形式:
{"lat": number, "lng": number}
`.trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "gemini api error", detail: t });
    }

    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // 返答からJSONだけ抜き出す（保険）
    const m = text.match(/\{[\s\S]*?\}/); // ★ 非貪欲にする
    if (!m) return res.status(500).json({ error: "no json in response", raw: text });

    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch (e) {
      return res.status(500).json({ error: "json parse failed", raw: m[0] });
    }

    const lat = Number(obj.lat);
    const lng = Number(obj.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(500).json({ error: "invalid lat/lng", raw: obj });
    }

    res.json({ lat, lng });
  } catch (e) {
    res.status(500).json({ error: "server error", detail: e?.message ?? String(e) });
  }
});

app.post("/interpret-polygon", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

    const prompt = `
あなたは3Dマップに描画する「ポリゴン仕様」を作るAIです。
出力は **必ずJSONのみ**。説明文、コードブロック、前置き、コメントは禁止。

【厳守ルール】
- 出力は JSON 1個のみ（配列ではなくオブジェクト）
- JSON内にコメント禁止（// や /* */ を入れない）
- 文字列は必ずダブルクォート
- 値は具体値（number 等の型名を書かない）
- shape は "circle" / "rect" / "triangle" / "ngon" のいずれか

【出力JSONの形式（このキーのみを使う）】
{
  "shape": "circle",
  "sides": 6,
  "size": "medium",
  "radius": 260,
  "meters": 260,
  "height": 60,
  "color": "#ff0000",
  "opacity": 0.4,
  "grid": { "rows": 1, "cols": 1 },
  "zones": [
    { "row": 0, "col": 0, "color": "#ff0000", "opacity": 0.4, "height": 60 }
  ]
}

【値の決め方】
- shape:
  - "五角形/六角形/八角形/多角形" があれば "ngon" にする
  - ngonの sides: 五角形=5, 六角形=6, 多角形=8（迷ったら8）
- size:
  - "小さめ/小さい" → "small"
  - "広め/大きめ/広い" → "large"
  - それ以外 → "medium"
- radius/meters（単位m）:
  - 文中に "1km" があれば 1000
  - 文中に "500m" があれば 500
  - "半径500m" があれば radius=500
  - 指定が無ければ radius/meters は 0 にしてOK（クライアント側がsizeで補完するため）
- height:
  - "高さ120" や "高さ120m" があれば 120
  - 無ければ 60
- opacity:
  - "透明度0.2" があれば 0.2
  - "半透明" があれば 0.35
  - 無ければ 0.4
- color:
  - 危険/警告/立入禁止 → "#ff0000"
  - 注意 → "#ffaa00"
  - 安全/避難 → "#00aa55"
  - 無指定 → "#ff0000"

【区分け（超重要）】
- 入力文に「区分け」「細かく」「グリッド」「段階」「2×3」「3x2」「3段階」などが含まれる場合、
  必ず grid と zones を返すこと。
- grid.rows と grid.cols を必ず設定し、zones は全セルぶん返してよい（推奨）。
- 例：2×3 → rows=2, cols=3
- zones は {row, col} を0始まりで埋める。
- 危険→注意→安全の段階があれば、色とopacityで差を付ける（危険ほど濃く）。

【入力文】
${text}
`.trim();

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "gemini api error", detail: t });
    }

    const j = await r.json();
    const textOut = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // --- 解決策A：最初の { と最後の } だけを使う ---
    const first = textOut.indexOf("{");
    const last = textOut.lastIndexOf("}");

    if (first === -1 || last === -1 || last <= first) {
      return res.status(500).json({
        error: "no json in response",
        raw: textOut
      });
    }

    const jsonText = textOut.slice(first, last + 1);

    let spec;
    try {
      spec = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({
        error: "json parse failed",
        extracted: jsonText,
        raw: textOut
      });
    }

    res.json(spec);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: e?.message ?? String(e) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not set" });
    }

    const sid = getSessionId(req, res);

    const msg = String(req.body?.message ?? "").trim();
    const state = req.body?.state ?? null;

    if (!msg) return res.status(400).json({ error: "message is required" });

    // 会話履歴削除コマンド
    if (msg.includes("会話履歴削除")) {
      chatStore.delete(sid);
      return res.json({
        reply: "承知しました。会話履歴を削除しました。引き続き、建築・都市・配置計画の相談に対応します。",
        action: "chat",
        needs_confirm: false,
        confirm_text: "",
        prompt: "",
        state: null
      });
    }

    // 履歴へ追加（user）
    const history = chatStore.get(sid) ?? [];
    history.push({ role: "user", content: msg });
    chatStore.set(sid, clampHistory(history));

    const SYSTEM = `
あなたはAI建築コンサルタントです。ユーザーの要望を「建築計画・街区計画・景観・スケール感・導線・用途・周辺環境」に配慮して助言します。
口調は丁寧で、専門用語は必要な時だけ短く説明し、提案は理由付きで簡潔に提示します。

重要：
- 雑談・質問・相談など「操作指示が明確でない」場合は action="chat" にする（実行提案しない）。
- 生成/移動/戻す/クリア/回転/変更の操作は、ユーザーの意図が明確な時のみ提案する。
- 操作を提案する場合でも、勝手に実行させないため needs_confirm=true を返し、confirm_text に「何をするか」を短く書く。
- 返答は必ず次のJSONのみで返す（余計な文章を出さない）：
- 「おすすめポリゴン」を聞かれたら、「戸建て住宅」と答える。

【モデル設置ルール（厳守）】
- 「モデル」「建物モデル」「3Dモデル」「gltf」「配置ボタン」などが関係する要望は、
  いかなる場合も自動実行・提案をしない。
- 必ず action="chat" とし、
  「上部のモデル選択から〜モデルを選択し場所を入力してから、配置ボタンを押してください」という
  ユーザー操作案内のみを返す。
- needs_confirm は false。
- 「おすすめモデル」を聞かれたら、「モダン住宅」と答える。

{
  "reply": "ユーザー向けの回答（建築の専門家として）",
  "action": "chat | generate | fly | undo | clear | rotate | modify",
  "needs_confirm": true,
  "confirm_text": "実行確認文",
  "prompt": "generate/fly用（不要なら空文字）",
  "state": { "polygons": [] } または null
}
`.trim();

    // Geminiに渡すテキストを組み立て（履歴20件まで）
    const histText = (chatStore.get(sid) ?? [])
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const prompt = `
${SYSTEM}

【現在の状態（参考）】
${state ? JSON.stringify(state).slice(0, 4000) : "null"}

【会話履歴（直近10往復）】
${histText}

【ユーザーの最新発話】
${msg}
`.trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "gemini api error", detail: t });
    }

    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // JSON抽出（保険）
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      return res.status(500).json({ error: "no json", raw: text });
    }

    let obj;
    try {
      obj = JSON.parse(text.slice(first, last + 1));
    } catch (e) {
      return res.status(500).json({ error: "json parse failed", raw: text });
    }

    // 最低限の整形（フロントが使いやすい形に）
    const out = {
      reply: String(obj.reply ?? "").trim() || "承知しました。",
      action: String(obj.action ?? "chat").trim(),
      needs_confirm: obj.needs_confirm !== false, // 基本true（会話のみならfalseでもOK）
      confirm_text: String(obj.confirm_text ?? "").trim(),
      prompt: String(obj.prompt ?? "").trim(),
      state: obj.state ?? null
    };

    // 雑談なら action=chat を強制（暴走抑制）
    if (!["chat", "generate", "fly", "undo", "clear", "rotate", "modify"].includes(out.action)) {
      out.action = "chat";
      out.needs_confirm = false;
    }

    // action=chat の場合は確認不要
    if (out.action === "chat") {
      out.needs_confirm = false;
      out.confirm_text = "";
      out.prompt = "";
      out.state = null;
    }

    // assistant reply を履歴へ追加
    const h2 = chatStore.get(sid) ?? [];
    h2.push({ role: "assistant", content: out.reply });
    chatStore.set(sid, clampHistory(h2));

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: "server error", detail: e?.message ?? String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`server running on port ${port}`);
});