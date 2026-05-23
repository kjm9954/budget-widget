const ALLOWED_ORIGIN = "https://kjm9954.github.io";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Widget-Key",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isAuthorized(request, env) {
  const key = request.headers.get("X-Widget-Key");
  return Boolean(env.WIDGET_API_KEY && key === env.WIDGET_API_KEY);
}

async function ensureBudgetStateTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS budget_states (
      space TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
}

async function ensureMiniWidgetDateTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mini_widget_dates (
      slot TEXT PRIMARY KEY,
      selected_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
}

function parseState(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const isBudgetStateRoute = path === "/budget-state" || (path === "/" && url.searchParams.has("p"));
    const protectedPaths = ["/history", "/record", "/expenses", "/expense", "/mini-date"];

    if ((protectedPaths.includes(path) || isBudgetStateRoute) && !isAuthorized(request, env)) {
      return json({ ok: false, error: "Unauthorized" }, 401, origin);
    }

    try {
      if (path === "/history" && request.method === "GET") {
        const space = url.searchParams.get("space") || "main";

        const result = await env.DB.prepare(
          `SELECT date, emotions, memo, created_at, updated_at
           FROM emotion_records
           WHERE space = ?
           ORDER BY date DESC`
        )
          .bind(space)
          .all();

        const records = result.results.map((row) => ({
          date: row.date,
          emotions: parseState(row.emotions) || [],
          memo: row.memo || "",
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));

        return json(records, 200, origin);
      }

      if (path === "/record" && request.method === "POST") {
        const body = await readJson(request);
        const space = body.space || "main";
        const date = body.date;
        const emotions = Array.isArray(body.emotions) ? body.emotions : [];
        const memo = body.memo || "";

        if (!date) {
          return json({ ok: false, error: "date is required" }, 400, origin);
        }

        await env.DB.prepare(
          `INSERT INTO emotion_records (space, date, emotions, memo, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(space, date)
           DO UPDATE SET
             emotions = excluded.emotions,
             memo = excluded.memo,
             updated_at = CURRENT_TIMESTAMP`
        )
          .bind(space, date, JSON.stringify(emotions), memo)
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/record" && request.method === "PATCH") {
        const body = await readJson(request);
        const space = body.space || "main";
        const oldDate = body.oldDate;
        const date = body.date;

        if (!oldDate || !date) {
          return json({ ok: false, error: "oldDate and date are required" }, 400, origin);
        }

        await env.DB.prepare(
          `UPDATE emotion_records
           SET date = ?, updated_at = CURRENT_TIMESTAMP
           WHERE space = ? AND date = ?`
        )
          .bind(date, space, oldDate)
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/record" && request.method === "DELETE") {
        const body = await readJson(request);
        const space = body.space || "main";
        const date = body.date;

        if (!date) {
          return json({ ok: false, error: "date is required" }, 400, origin);
        }

        await env.DB.prepare("DELETE FROM emotion_records WHERE space = ? AND date = ?")
          .bind(space, date)
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/expenses" && request.method === "GET") {
        const space = url.searchParams.get("space") || "main";
        const date = url.searchParams.get("date");

        const query = date
          ? "SELECT * FROM expenses WHERE space = ? AND date = ? ORDER BY created_at DESC"
          : "SELECT * FROM expenses WHERE space = ? ORDER BY date DESC, created_at DESC";

        const stmt = date
          ? env.DB.prepare(query).bind(space, date)
          : env.DB.prepare(query).bind(space);

        const result = await stmt.all();
        return json(result.results, 200, origin);
      }

      if (path === "/expense" && request.method === "POST") {
        const body = await readJson(request);
        const space = body.space || "main";
        const date = body.date;
        const item = body.item || "";
        const amount = Number(body.amount || 0);
        const category = body.category || "";
        const memo = body.memo || "";

        if (!date || !item) {
          return json({ ok: false, error: "date and item are required" }, 400, origin);
        }

        await env.DB.prepare(
          `INSERT INTO expenses (space, date, item, amount, category, memo)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(space, date, item, amount, category, memo)
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/expense" && request.method === "PATCH") {
        const body = await readJson(request);
        const id = body.id;

        if (!id) {
          return json({ ok: false, error: "id is required" }, 400, origin);
        }

        await env.DB.prepare(
          `UPDATE expenses
           SET date = ?, item = ?, amount = ?, category = ?, memo = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(
            body.date,
            body.item || "",
            Number(body.amount || 0),
            body.category || "",
            body.memo || "",
            id
          )
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/expense" && request.method === "DELETE") {
        const body = await readJson(request);
        const id = body.id;

        if (!id) {
          return json({ ok: false, error: "id is required" }, 400, origin);
        }

        await env.DB.prepare("DELETE FROM expenses WHERE id = ?")
          .bind(id)
          .run();

        return json({ ok: true }, 200, origin);
      }

      if (path === "/mini-date" && request.method === "GET") {
        const slot = url.searchParams.get("slot") || "default";
        await ensureMiniWidgetDateTable(env);

        const row = await env.DB.prepare("SELECT selected_date FROM mini_widget_dates WHERE slot = ?")
          .bind(slot)
          .first();

        return json({ date: row ? row.selected_date : "" }, 200, origin);
      }

      if (path === "/mini-date" && request.method === "PUT") {
        const slot = url.searchParams.get("slot") || "default";
        const body = await readJson(request);
        const date = body.date || body.selectedDate;

        if (!date) {
          return json({ ok: false, error: "date is required" }, 400, origin);
        }

        await ensureMiniWidgetDateTable(env);
        await env.DB.prepare(
          `INSERT INTO mini_widget_dates (slot, selected_date, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(slot)
           DO UPDATE SET
             selected_date = excluded.selected_date,
             updated_at = CURRENT_TIMESTAMP`
        )
          .bind(slot, date)
          .run();

        return json({ ok: true, date }, 200, origin);
      }

      if (isBudgetStateRoute && request.method === "GET") {
        const space = url.searchParams.get("space") || url.searchParams.get("p") || "main";
        await ensureBudgetStateTable(env);

        const row = await env.DB.prepare("SELECT state FROM budget_states WHERE space = ?")
          .bind(space)
          .first();

        return json({ state: parseState(row && row.state), ts: Date.now() }, 200, origin);
      }

      if (isBudgetStateRoute && request.method === "PUT") {
        const space = url.searchParams.get("space") || url.searchParams.get("p") || "main";
        const state = await readJson(request);
        await ensureBudgetStateTable(env);

        await env.DB.prepare(
          `INSERT INTO budget_states (space, state, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(space)
           DO UPDATE SET
             state = excluded.state,
             updated_at = CURRENT_TIMESTAMP`
        )
          .bind(space, JSON.stringify(state))
          .run();

        return json({ ok: true, ts: Date.now() }, 200, origin);
      }

      return json({ ok: true, message: "notion-widgets-api is running" }, 200, origin);
    } catch (error) {
      return json({ ok: false, error: String(error.message || error) }, 500, origin);
    }
  },
};
