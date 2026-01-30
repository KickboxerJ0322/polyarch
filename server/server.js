import express from "express";
import fetch from "node-fetch";

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

if (!GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is not set. Set env var before starting.");
}

// CORS（index.html を別ポートで開くため）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

    const { message, state } = req.body ?? {};
    const msg = String(message ?? "").trim();
    if (!msg) return res.status(400).json({ error: "message is required" });

    // ★ フロントが期待する返却スキーマを強制
    // - generate/fly は prompt を必須にする（prompt欄へ流し込むため）
    // - modify のときだけ state を返す
    const prompt = `
あなたは「3DマップUI操作コマンド」を返すAIです。
出力は **必ずJSONのみ**。説明文・コードブロック禁止。

# 返すJSONスキーマ（厳守）
{
  "reply": "日本語の短い返答",
  "action": "generate" | "fly" | "undo" | "clear" | "rotate" | "modify" | "open-model-picker",
  "prompt": "generate/flyの時だけ必須。prompt欄に入れる自然文。例: 東京駅に 城",
  "state": { "polygons": [...] } // modify の時だけ。受け取ったstateをベースに必要箇所だけ更新した完全なstate
}

# 重要ルール
- action が generate のとき:
  - prompt は必須（ユーザー指示から「場所＋対象」を含む自然文を作る）
  - state は返さない
- action が fly のとき:
  - prompt は必須（飛び先の場所が分かる自然文にする）
  - state は返さない
- undo/clear/rotate のとき:
  - prompt は不要
  - state は返さない
- modify のとき:
  - state は必須（polygons配列構造は維持、指定された変更のみ反映）
  - 追加/削除は禁止（色・opacity・height・meters・center などの変更のみ）
- open-model-picker のとき:
  - "reply": "モデルを選択してください。",
- reply は日本語で短く
- opacity は 0〜0.7

# ユーザー指示
${msg}

# 現在state（modify用）
${JSON.stringify(state ?? {}, null, 2)}
`.trim();

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      }
    );

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

    // ===== ここから「壊れた返答の修復」 =====

    const action = String(obj.action ?? "").trim();
    const reply = String(obj.reply ?? "").trim() || "了解。";

    const allowed = new Set(["generate", "fly", "undo", "clear", "rotate", "modify"]);

    // action が無い/不正なら、簡易ルールで推定
    let fixedAction = allowed.has(action) ? action : null;
    if (!fixedAction) {
      if (/回転/.test(msg)) fixedAction = "rotate";
      else if (/undo|戻|取り消/.test(msg)) fixedAction = "undo";
      else if (/消|クリア|全消/.test(msg)) fixedAction = "clear";
      else if (/飛|移動|フライ|fly/i.test(msg)) fixedAction = "fly";
      else if (/色|opacity|透明|高さ|大き|小さ/.test(msg)) fixedAction = "modify";
      else fixedAction = "generate";
    }

    // generate/fly は prompt が無いとフロントが動かないので必ず埋める
    let fixedPrompt = (obj.prompt != null) ? String(obj.prompt).trim() : "";

    if ((fixedAction === "generate" || fixedAction === "fly") && !fixedPrompt) {
      // 最低限「ユーザー入力をそのまま prompt」にする（これで動く）
      fixedPrompt = msg;
    }

    // modify 以外は state を返さない（フロントが混乱しないように）
    let fixedState = undefined;
    if (fixedAction === "modify") {
      fixedState = obj.state ?? state ?? { polygons: [] };
      // 念のため polygons が配列でない場合の補正
      if (!Array.isArray(fixedState.polygons)) fixedState.polygons = Array.isArray(state?.polygons) ? state.polygons : [];
    }

    // 最終レスポンス
    const out = {
      reply,
      action: fixedAction,
      ...(fixedPrompt ? { prompt: fixedPrompt } : {}),
      ...(fixedState ? { state: fixedState } : {})
    };

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: e?.message ?? String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`server running on port ${port}`);
});