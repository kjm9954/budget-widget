/* =========================================================================
   Budget Widget — Cloudflare Worker 프록시 (Notion API 중계)
   Notion API는 브라우저 CORS를 막아 직접 호출 불가 → 이 Worker가 프록시.

   WorkLog 의 cloudflare-worker.js 와 동일 패턴이며 노션 페이지 안에 만들
   toggle 블록의 라벨만 다릅니다 ("Budget State (do not edit)").
   같은 노션 페이지에 WorkLog 와 Budget 위젯을 동시에 임베드해도 충돌 X.

   ── 배포 방법 ───────────────────────────────────────────────────────────
   1) https://dash.cloudflare.com → Workers & Pages → Create → Worker
   2) 이 파일 전체를 "Edit code"에 붙여넣고 Save & Deploy
   3) Settings → Variables 에서 아래 환경변수 추가:
        NOTION_TOKEN    = (Notion Integration 토큰, "Encrypt" 체크)
        WIDGET_SECRET   = (임의의 긴 랜덤 문자열, "Encrypt" 체크, 선택)
   4) Worker URL 복사 (예: https://budget-sync.<your>.workers.dev)
   5) budget_widget.html 의 WORKER_URL 상수에 붙여넣고 push
   6) Notion 페이지 임베드 URL 뒤에 ?np=<page_id>[&nk=<secret>] 추가
        예: https://kjm9954.github.io/budget-widget/budget_widget.html?np=abcd1234...&nk=mySecret
   7) Notion 에서 통합(Integration)을 해당 페이지에 Connect
   ───────────────────────────────────────────────────────────────────────

   엔드포인트
     GET  /?p=<page_id>   → toggle("Budget State") 내부 code 블록 JSON 반환
     PUT  /?p=<page_id>   (body: state JSON) → toggle 내부 code 블록 덮어쓰기
                            없으면 toggle+code 생성
   요청 헤더
     X-Widget-Key: <WIDGET_SECRET>  (WIDGET_SECRET 설정 시 필수)
   ========================================================================= */

const NOTION_VERSION = '2022-06-28';
const CODE_LANGUAGE = 'json';
const RICH_TEXT_MAX = 2000;
const TOGGLE_LABEL = 'Budget State (do not edit)';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const pageId = url.searchParams.get('p');
    if (!pageId) return json({ error: 'missing query param: p' }, 400, cors);
    if (!env.NOTION_TOKEN) return json({ error: 'server misconfig: NOTION_TOKEN not set' }, 500, cors);

    if (env.WIDGET_SECRET) {
      const key = request.headers.get('X-Widget-Key');
      if (key !== env.WIDGET_SECRET) return json({ error: 'unauthorized' }, 401, cors);
    }

    const notion = (path, opts = {}) => fetch('https://api.notion.com/v1' + path, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + env.NOTION_TOKEN,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });

    try {
      if (request.method === 'GET') {
        const state = await loadState(notion, pageId);
        return json({ state, ts: Date.now() }, 200, cors);
      }
      if (request.method === 'PUT') {
        const body = await request.json();
        await saveState(notion, pageId, body);
        return json({ ok: true, ts: Date.now() }, 200, cors);
      }
      return json({ error: 'method not allowed' }, 405, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function listChildren(notion, pageId) {
  const res = await notion(`/blocks/${pageId}/children?page_size=100`);
  if (!res.ok) throw new Error('notion list failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

function readRichText(arr) {
  return (arr || []).map(r => r.plain_text || '').join('');
}

function parseCodeJson(codeBlock) {
  if (!codeBlock) return null;
  const text = readRichText(codeBlock.code && codeBlock.code.rich_text);
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function findToggle(notion, pageId) {
  const data = await listChildren(notion, pageId);
  const results = data.results || [];
  const toggle = results.find(b => b && b.type === 'toggle'
    && readRichText(b.toggle && b.toggle.rich_text).startsWith(TOGGLE_LABEL));
  return { toggle };
}

async function loadState(notion, pageId) {
  const { toggle } = await findToggle(notion, pageId);
  if (!toggle) return null;
  const children = await listChildren(notion, toggle.id);
  const codeBlock = (children.results || []).find(b => b && b.type === 'code');
  return parseCodeJson(codeBlock);
}

function buildRichText(text) {
  const chunks = splitChunks(text, RICH_TEXT_MAX);
  return chunks.map(c => ({ type: 'text', text: { content: c } }));
}

async function saveState(notion, pageId, state) {
  const text = JSON.stringify(state);
  const richText = buildRichText(text);

  const { toggle } = await findToggle(notion, pageId);

  if (toggle) {
    const children = await listChildren(notion, toggle.id);
    const codeBlock = (children.results || []).find(b => b && b.type === 'code');
    if (codeBlock) {
      const upd = await notion(`/blocks/${codeBlock.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ code: { rich_text: richText, language: CODE_LANGUAGE } }),
      });
      if (!upd.ok) throw new Error('notion patch failed: ' + upd.status + ' ' + await upd.text());
    } else {
      const add = await notion(`/blocks/${toggle.id}/children`, {
        method: 'PATCH',
        body: JSON.stringify({
          children: [{
            object: 'block', type: 'code',
            code: { rich_text: richText, language: CODE_LANGUAGE },
          }],
        }),
      });
      if (!add.ok) throw new Error('notion append failed: ' + add.status + ' ' + await add.text());
    }
  } else {
    const add = await notion(`/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({
        children: [{
          object: 'block', type: 'toggle',
          toggle: {
            rich_text: [{ type: 'text', text: { content: TOGGLE_LABEL } }],
            children: [{
              object: 'block', type: 'code',
              code: { rich_text: richText, language: CODE_LANGUAGE },
            }],
          },
        }],
      }),
    });
    if (!add.ok) throw new Error('notion append failed: ' + add.status + ' ' + await add.text());
  }
}

function splitChunks(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}
