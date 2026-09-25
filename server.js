import express from "express";

const app = express();
const router = express.Router();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SKIP_HEADERS = new Set([
  "content-security-policy", "content-security-policy-report-only",
  "x-frame-options", "strict-transport-security",
  "content-encoding", "transfer-encoding", "connection", "keep-alive",
]);

function rewriteSetCookie(raw) {
  return raw.split(/;\s*/g).filter(part => {
    const lower = part.trim().toLowerCase();
    return !lower.startsWith("domain=") && !lower.startsWith("samesite=");
  }).join("; ") + "; SameSite=None; Secure";
}

function resolveUrl(base, rel) {
  if (!rel || rel.startsWith("javascript:") || rel.startsWith("data:") || rel.startsWith("blob:") || rel.startsWith("mailto:") || rel.startsWith("tel:") || rel === "#" || rel.startsWith("#")) return null;
  try { return new URL(rel, base).href; } catch { return null; }
}

function toProxy(targetUrl, proxyBase) {
  return `${proxyBase}?url=${encodeURIComponent(targetUrl)}`;
}

function rewriteAttr(html, attrRegex, base, proxyBase) {
  return html.replace(attrRegex, (match, pre, q, url) => {
    const resolved = resolveUrl(base, url.trim());
    if (!resolved) return match;
    if (resolved.startsWith(proxyBase)) return match;
    return `${pre}${q}${toProxy(resolved, proxyBase)}${q}`;
  });
}

function rewriteSrcset(srcset, base, proxyBase) {
  return srcset.replace(/([^\s,]+)(\s+\d+[wx])?/g, (match, url, descriptor) => {
    const resolved = resolveUrl(base, url);
    if (!resolved) return match;
    return toProxy(resolved, proxyBase) + (descriptor || "");
  });
}

function rewriteCss(css, base, proxyBase) {
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (match, q, url) => {
    const resolved = resolveUrl(base, url.trim());
    if (!resolved) return match;
    return `url(${q}${toProxy(resolved, proxyBase)}${q})`;
  });
}

function buildInjectedScript(pageUrl, proxyBase) {
  return `<script>
(function(){
  var PROXY="${proxyBase}";
  var PAGE="${pageUrl}";
  function toProxy(u){
    if(!u)return u;
    try{if(u.startsWith(PROXY)||u.startsWith("javascript:")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("mailto:")||u.startsWith("#"))return u;}catch(e){}
    try{return PROXY+"?url="+encodeURIComponent(new URL(u,PAGE).href);}catch(e){return u;}
  }
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    if(typeof input==="string"&&!input.startsWith(PROXY))input=toProxy(input);
    return _fetch.call(this,input,init);
  };
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{if(typeof u==="string")u=toProxy(u);}catch(e){}
    var args=Array.prototype.slice.call(arguments);
    args[1]=u;
    return _open.apply(this,args);
  };
  var _push=history.pushState,_replace=history.replaceState;
  history.pushState=function(s,t,u){return _push.call(this,s,t,u?toProxy(u):u);};
  history.replaceState=function(s,t,u){return _replace.call(this,s,t,u?toProxy(u):u);};
  document.addEventListener("click",function(e){
    var el=e.target;
    while(el&&el.tagName!=="A")el=el.parentElement;
    if(!el)return;
    var href=el.getAttribute("href");
    if(!href||href.startsWith("javascript:")||href.startsWith("#"))return;
    var proxied=toProxy(href);
    if(proxied!==href){e.preventDefault();window.location.href=proxied;}
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target;
    if(!f)return;
    if(!f.method||f.method.toUpperCase()==="GET"){
      e.preventDefault();
      try{
        var tUrl=new URL(f.action||PAGE,PAGE);
        var fd=new FormData(f);
        for(var p of fd.entries())tUrl.searchParams.append(p[0],p[1]);
        window.location.href=toProxy(tUrl.href);
      }catch(err){}
    }else{
      if(f.action){try{f.action=toProxy(f.action);}catch(err){}}
    }
  },true);
  var origSubmit=HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit=function(){if(this.action){try{this.action=toProxy(this.action);}catch(e){}}origSubmit.call(this);};
  try{if(window.top!==window){Object.defineProperty(window,"top",{get:function(){return window;}});}}catch(e){}
})();
<\/script>`;
}

function rewriteHtml(html, pageUrl, proxyBase) {
  html = html.replace(/<base[^>]*>/gi, "");
  html = rewriteAttr(html, /(<(?:a|link|area)\b[^>]*?\shref=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = rewriteAttr(html, /(<(?:img|script|source|video|audio|iframe|embed|input|track)\b[^>]*?\ssrc=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = rewriteAttr(html, /(<form\b[^>]*?\saction=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = rewriteAttr(html, /(<[^>]*?\sdata-src=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = rewriteAttr(html, /(<[^>]*?\sdata-href=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = rewriteAttr(html, /(<video\b[^>]*?\sposter=)(["'])([^"']*)\2/gi, pageUrl, proxyBase);
  html = html.replace(/(<(?:img|source)\b[^>]*?\ssrcset=)(["'])([^"']*)\2/gi, (match, pre, q, srcset) => {
    return `${pre}${q}${rewriteSrcset(srcset, pageUrl, proxyBase)}${q}`;
  });
  html = html.replace(/(\sstyle=["'])([^"']*)(['"])/gi, (match, pre, styleVal, close) => {
    return pre + rewriteCss(styleVal, pageUrl, proxyBase) + close;
  });
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
    return open + rewriteCss(css, pageUrl, proxyBase) + close;
  });
  const script = buildInjectedScript(pageUrl, proxyBase);
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([\s>])/i, `<head$1${script}`);
  } else if (/<html[\s>]/i.test(html)) {
    html = html.replace(/<html([\s>])/i, `<html$1${script}`);
  } else {
    html = script + html;
  }
  return html;
}

async function pipeStream(webStream, res) {
  const reader = webStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  res.end();
}

// ─── Web proxy (server-side fetch, rewrite, serve) ──────────────────────────
router.get("/proxy/page", async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  if (!targetUrl) { res.status(400).send("Missing url"); return; }

  let parsed;
  try { parsed = new URL(targetUrl); } catch { res.status(400).send("Invalid URL"); return; }
  if (!["http:", "https:"].includes(parsed.protocol)) { res.status(400).send("Only http/https supported"); return; }

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost";
  const proxyBase = `${proto}://${host}/api/proxy/page`;
  const browserCookies = req.headers["cookie"];

  try {
    const headers = {
      "User-Agent": req.headers["user-agent"] || UA,
      Accept: req.headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      Referer: parsed.origin,
    };
    if (browserCookies) headers.Cookie = browserCookies;
    if (req.headers.range) headers.Range = req.headers.range;

    const fetchRes = await fetch(targetUrl, { headers, redirect: "follow" });
    res.status(fetchRes.status);

    const finalUrl = fetchRes.url || targetUrl;
    const ct = fetchRes.headers.get("content-type") || "application/octet-stream";

    fetchRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "set-cookie") {
        res.appendHeader("Set-Cookie", rewriteSetCookie(value));
      } else if (!SKIP_HEADERS.has(lower)) {
        try { res.setHeader(key, value); } catch {}
      }
    });

    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (ct.includes("text/html")) {
      const html = await fetchRes.text();
      const rewritten = rewriteHtml(html, finalUrl, proxyBase);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(rewritten);
    } else if (ct.includes("text/css")) {
      const css = await fetchRes.text();
      const rewritten = rewriteCss(css, finalUrl, proxyBase);
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.send(rewritten);
    } else if (ct.includes("javascript") || ct.includes("json") || ct.includes("text/plain")) {
      const text = await fetchRes.text();
      res.setHeader("Content-Type", ct);
      res.send(text);
    } else {
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (fetchRes.body) {
        await pipeStream(fetchRes.body, res);
      } else {
        const buf = await fetchRes.arrayBuffer();
        res.send(Buffer.from(buf));
      }
    }
  } catch (err) {
    res.status(502).send(`<html><body style="background:#000;color:#fff;font-family:sans-serif;padding:40px"><h2>Proxy error</h2><p>${String(err)}</p></body></html>`);
  }
});

// ─── JSON Search API ────────────────────────────────────────────────────────
function parseWebResults(html) {
  const results = [];
  const blocks = html.split(/<div class="result[^"]*results_links[^"]*web-result[^"]*">/);
  blocks.shift();
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const urlMatch = block.match(/<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch) {
      let href = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      const displayUrl = urlMatch ? urlMatch[1].replace(/<[^>]+>/g, "").trim() : href;
      try {
        if (href.startsWith("//duckduckgo.com/l/?")) {
          const uddg = new URL("https:" + href).searchParams.get("uddg");
          if (uddg) href = decodeURIComponent(uddg);
        }
      } catch {}
      if (title && href && !href.startsWith("https://duckduckgo.com")) {
        results.push({ title, url: href, display_url: displayUrl, snippet });
      }
    }
  }
  return results;
}

router.get("/proxy/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const type = String(req.query.type || "web");
  const page = Math.max(1, Number(req.query.page || 1));

  if (!query) { res.status(400).json({ error: "Missing query" }); return; }

  try {
    if (type === "web") {
      const offset = (page - 1) * 10;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=-2&s=${offset}`;
      let response;
      try {
        response = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
      } catch {
        response = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url), { headers: { "User-Agent": UA } });
      }
      const html = await response.text();
      res.json({ results: parseWebResults(html) });

    } else if (type === "images") {
      const url = "https://www.bing.com/images/search?q=" + encodeURIComponent(query) + "&adlt=off";
      const bingRes = await fetch(url, { headers: { "User-Agent": UA, Cookie: "SRCHHPGUSR=ADLT=OFF;" } });
      const html = await bingRes.text();
      const matches = [...html.matchAll(/m="({.*?})"/g)];
      const results = [];
      for (let i = 0; i < Math.min(40, matches.length); i++) {
        try {
          const obj = JSON.parse(matches[i][1].replace(/&quot;/g, '"'));
          if (obj.murl && obj.turl) {
            results.push({
              title: obj.t || "Image",
              image: obj.murl,
              thumbnail: obj.turl.replace(/&amp;/g, "&"),
              url: obj.purl || obj.murl,
              width: obj.mw || 0,
              height: obj.mh || 0,
              source: obj.purl || "",
            });
          }
        } catch {}
      }
      res.json({ results });

    } else if (type === "videos") {
      const url = "https://www.bing.com/videos/search?q=" + encodeURIComponent(query) + "&adlt=off";
      const bingRes = await fetch(url, { headers: { "User-Agent": UA, Cookie: "SRCHHPGUSR=ADLT=OFF;" } });
      const html = await bingRes.text();
      const matches = [...html.matchAll(/mmeta="({.*?})"[^>]*><a aria-label="([^"]+)"/g)];
      const results = [];
      for (let i = 0; i < Math.min(30, matches.length); i++) {
        try {
          const obj = JSON.parse(matches[i][1].replace(/&quot;/g, '"'));
          if (obj.murl && obj.turl) {
            const rawTitle = matches[i][2].replace(/&#39;/g, "'").replace(/&amp;/g, "&");
            results.push({
              title: rawTitle.split(" &#183; ")[0] || "Video",
              content: obj.murl,
              images: { large: obj.turl.replace(/&amp;/g, "&") },
              publisher: "",
              uploader: "",
            });
          }
        } catch {}
      }
      res.json({ results });
    } else {
      res.status(400).json({ error: "Invalid type" });
    }
  } catch (err) {
    res.status(502).json({ error: "Search failed", detail: String(err) });
  }
});

// ─── Image proxy ────────────────────────────────────────────────────────────
router.get("/proxy/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) { res.status(400).end(); return; }
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Referer: new URL(url).origin } });
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch {
    res.status(502).end();
  }
});

// ─── SPA Frontend ───────────────────────────────────────────────────────────
const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EzBypass</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap');
  :root {
    color-scheme: dark;
    --bg: #050505; --bg-2: #0a0a0a; --bg-elev: #111111; --bg-elev-2: #171717;
    --border: #282828; --border-strong: #4b4b4b;
    --text: #f4f4f1; --text-dim: #a8a8a3; --text-mute: #676762;
    --accent: #f2f2f0; --accent-glow: #ffffff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Space Grotesk', sans-serif; -webkit-font-smoothing: antialiased; }
  .root { min-height: 100vh; display: flex; flex-direction: column; position: relative; overflow: hidden;
    background: radial-gradient(ellipse 70% 40% at 50% 0%, rgba(255,255,255,.095), transparent 70%), var(--bg); }
  .bg-grid { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .26;
    background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
    background-size: 64px 64px;
    mask-image: radial-gradient(ellipse at 50% 16%, #000 5%, transparent 66%); -webkit-mask-image: radial-gradient(ellipse at 50% 16%, #000 5%, transparent 66%); }
  .topbar { position: sticky; top: 0; z-index: 50; background: rgba(5,5,5,0.9); border-bottom: 1px solid var(--border);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); flex-shrink: 0; }
  .topbar-inner { max-width: 1100px; margin: 0 auto; padding: 0 16px; height: 56px; display: flex; align-items: center; gap: 10px; }
  .topbar-inner.browsing { max-width: none; }
  .icon-btn { width: 34px; height: 34px; border-radius: 8px; background: var(--bg-elev); border: 1px solid var(--border);
    color: var(--text-dim); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: border-color .15s, color .15s; }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent-glow); }
  .search-btn { padding: 9px 20px; background: var(--accent); color: #000; border: none; border-radius: 10px;
    font-size: 14px; font-weight: 600; cursor: pointer; flex-shrink: 0; transition: background .15s; font-family: inherit; }
  .search-btn:hover { background: var(--accent-glow); }
  .search-wrap { position: relative; flex: 1; }
  .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-mute); pointer-events: none; }
  .search-input { width: 100%; padding: 9px 14px 9px 42px; background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 10px; color: var(--text); font-size: 14px; outline: none; transition: border-color .15s; box-sizing: border-box; font-family: inherit; }
  .search-input:focus { border-color: var(--accent); }
  .address-input { flex: 1; padding: 7px 14px; background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 13px; outline: none; transition: border-color .15s; font-family: inherit; }
  .address-input:focus { border-color: var(--accent); }
  .tab-bar { max-width: 1100px; margin: 0 auto; padding: 0 16px; display: flex; gap: 4px; border-top: 1px solid var(--border); }
  .tab-btn { padding: 7px 16px; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-mute); font-size: 13px; font-weight: 400; cursor: pointer; text-transform: capitalize;
    transition: color .15s; margin-bottom: -1px; font-family: inherit; }
  .tab-btn.active { border-bottom-color: var(--accent); color: var(--accent-glow); font-weight: 600; }
  .tab-btn:hover { color: var(--text-dim); }
  .landing-tabs { display: flex; gap: 8px; margin-top: 4px; }
  .landing-tab { padding: 6px 14px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text-mute); font-size: 13px; cursor: pointer; text-transform: capitalize; transition: all .15s; font-family: inherit; }
  .landing-tab.active { background: rgba(255,255,255,0.15); border-color: var(--accent); color: var(--accent-glow); font-weight: 600; }
  .main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; flex: 1; position: relative; z-index: 1; }
  .landing { display: flex; flex-direction: column; align-items: center; padding-top: 60px; gap: 16px; }
  .landing h1 { font-size: 28px; font-weight: 700; }
  .landing p { font-size: 15px; color: var(--text-mute); text-align: center; max-width: 420px; }
  .dots { display: flex; gap: 6px; justify-content: center; padding-top: 60px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dot:nth-child(2) { animation-delay: .2s; } .dot:nth-child(3) { animation-delay: .4s; }
  @keyframes pulse { 0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)} }
  .error-box { margin-top: 40px; padding: 16px 20px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3);
    border-radius: 10px; color: #fca5a5; font-size: 14px; text-align: center; }
  .web-results { max-width: 740px; display: flex; flex-direction: column; gap: 2px; }
  .web-result { padding: 12px 14px; border-radius: 10px; border: 1px solid transparent; transition: background .12s, border-color .12s; cursor: default; }
  .web-result:hover { background: var(--bg-elev); border-color: var(--border); }
  .wr-url { font-size: 11px; color: var(--text-mute); margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 500px; }
  .wr-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 4px; line-height: 1.3; }
  .wr-snippet { font-size: 13px; color: var(--text-dim); line-height: 1.6; margin-bottom: 8px; }
  .wr-actions { display: flex; gap: 8px; }
  .wr-open { padding: 5px 14px; background: var(--accent); border: none; border-radius: 7px; color: #000; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s; font-family: inherit; }
  .wr-open:hover { background: var(--accent-glow); }
  .img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .img-card { border-radius: 10px; overflow: hidden; background: var(--bg-elev); border: 1px solid var(--border);
    cursor: pointer; transition: transform .15s, border-color .15s; aspect-ratio: 1/1; position: relative; }
  .img-card:hover { transform: scale(1.03); border-color: var(--accent); }
  .img-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .img-card .no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-mute); font-size: 12px; }
  .vid-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .vid-card { display: block; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px;
    overflow: hidden; text-decoration: none; transition: border-color .15s, transform .15s; cursor: pointer; }
  .vid-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .vid-thumb { position: relative; aspect-ratio: 16/9; background: var(--bg-2); }
  .vid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .vid-play-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.25); color: #fff; opacity: 0; transition: opacity .15s; }
  .vid-card:hover .vid-play-overlay { opacity: 1; }
  .vid-play-circle { width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.85); display: flex; align-items: center; justify-content: center; }
  .vid-meta { padding: 10px 12px 12px; }
  .vid-title { font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.4; margin-bottom: 4px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .vid-pub { font-size: 12px; color: var(--text-mute); }
  .load-more { display: flex; justify-content: center; margin-top: 32px; }
  .load-more-btn { padding: 10px 28px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-dim); font-size: 14px; font-weight: 500; cursor: pointer; transition: border-color .15s, color .15s; font-family: inherit; }
  .load-more-btn:hover { border-color: var(--accent); color: var(--accent-glow); }
  .lightbox { position: fixed; inset: 0; z-index: 999; background: rgba(0,0,0,0.88); backdrop-filter: blur(8px);
    display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; gap: 12px; }
  .lightbox img { max-width: 90vw; max-height: 80vh; border-radius: 10px; object-fit: contain; display: block; }
  .lb-info { display: flex; align-items: center; gap: 12px; }
  .lb-title { font-size: 13px; color: var(--text-dim); max-width: 500px; text-align: center; }
  .lb-source { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; background: var(--accent); color: #000;
    border-radius: 7px; font-size: 13px; font-weight: 500; text-decoration: none; flex-shrink: 0; cursor: pointer; border: none; font-family: inherit; }
  .lb-close { position: fixed; top: 16px; right: 16px; width: 36px; height: 36px; border-radius: 50%; background: var(--bg-elev);
    border: 1px solid var(--border); color: var(--text); font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .browser-frame { flex: 1; position: relative; display: flex; flex-direction: column; z-index: 1; }
  .progress-bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; z-index: 10; }
  .progress-bar-inner { height: 100%; background: var(--accent); animation: progress 1.5s ease-in-out infinite; transform-origin: left; }
  @keyframes progress { 0%{transform:scaleX(0) translateX(0)}50%{transform:scaleX(0.6) translateX(50%)}100%{transform:scaleX(0) translateX(200%)} }
  .browser-frame iframe { flex: 1; width: 100%; border: none; min-height: calc(100vh - 56px); display: block; }
  @media (max-width: 600px) {
    .img-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
    .vid-grid { grid-template-columns: 1fr; }
    .topbar-inner { padding: 0 10px; gap: 6px; }
    .icon-btn { width: 30px; height: 30px; border-radius: 6px; }
  }
</style>
</head>
<body>
<div class="root" id="app"><div class="bg-grid"></div></div>
<script>
(function() {
  var API = '/api';
  var state = {
    query: '', submittedQuery: '', tab: 'web',
    webResults: [], imageResults: [], videoResults: [],
    loading: false, error: null, page: 1, hasMore: false,
    browseUrl: null, addressBar: '', iframeLoading: false,
    lightbox: null
  };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki], v = attrs[k];
        if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); }
        else if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
        else if (k === 'className') { el.className = v; }
        else if (k === 'innerHTML') { el.innerHTML = v; }
        else { el.setAttribute(k, v); }
      }
    }
    for (var ci = 0; ci < children.length; ci++) {
      var c = children[ci];
      if (c == null) continue;
      if (Array.isArray(c)) { for (var j = 0; j < c.length; j++) { if (c[j]) el.appendChild(typeof c[j] === 'string' ? document.createTextNode(c[j]) : c[j]); } }
      else { el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    }
    return el;
  }

  function proxyPageUrl(u) { return API + '/proxy/page?url=' + encodeURIComponent(u); }
  function proxyImgUrl(u) { return API + '/proxy/image?url=' + encodeURIComponent(u); }
  function isUrl(s) { return /^https?:\\/\\//i.test(s.trim()) || /^[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}(\\/|$)/.test(s.trim()); }

  function doSearch(q, t, p, append) {
    state.loading = true; state.error = null; render();
    fetch(API + '/proxy/search?q=' + encodeURIComponent(q) + '&type=' + t + '&page=' + p)
      .then(function(res) { if (!res.ok) throw new Error('Search failed (' + res.status + ')'); return res.json(); })
      .then(function(data) {
        var results = data.results || [];
        if (t === 'web') { state.webResults = append ? state.webResults.concat(results) : results; state.hasMore = results.length >= 10; }
        else if (t === 'images') { state.imageResults = append ? state.imageResults.concat(results) : results; state.hasMore = results.length >= 40; }
        else if (t === 'videos') { state.videoResults = append ? state.videoResults.concat(results) : results; state.hasMore = results.length >= 25; }
      })
      .catch(function(e) { state.error = e.message || 'Search failed'; })
      .finally(function() { state.loading = false; render(); });
  }

  function handleSubmit(q) {
    q = (q || '').trim(); if (!q) return;
    if (isUrl(q)) {
      var url = /^https?:\\/\\//i.test(q) ? q : 'https://' + q;
      openInProxy(url);
    } else {
      state.submittedQuery = q; state.page = 1;
      state.webResults = []; state.imageResults = []; state.videoResults = [];
      doSearch(q, state.tab, 1, false);
    }
  }

  function openInProxy(url) { state.browseUrl = url; state.addressBar = url; state.iframeLoading = true; render(); }
  function exitBrowser() { state.browseUrl = null; state.addressBar = ''; render(); }

  function changeTab(t) {
    state.tab = t; state.page = 1;
    if (state.submittedQuery) {
      if (t === 'web') state.webResults = [];
      if (t === 'images') state.imageResults = [];
      if (t === 'videos') state.videoResults = [];
      doSearch(state.submittedQuery, t, 1, false);
    } else { render(); }
  }

  function loadMore() { state.page++; doSearch(state.submittedQuery, state.tab, state.page, true); }

  function render() {
    var root = document.getElementById('app');
    root.innerHTML = '<div class="bg-grid"></div>';

    var currentResults = state.tab === 'web' ? state.webResults : state.tab === 'images' ? state.imageResults : state.videoResults;
    var hasResults = currentResults.length > 0;

    // HEADER
    var header = h('header', { className: 'topbar' });
    var inner = h('div', { className: 'topbar-inner' + (state.browseUrl ? ' browsing' : '') });

    if (state.browseUrl) {
      inner.appendChild(h('button', { className: 'icon-btn', title: 'Back to search', onClick: exitBrowser, innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' }));
      inner.appendChild(h('button', { className: 'icon-btn', title: 'Refresh', onClick: function() { state.iframeLoading = true; render(); var f = document.getElementById('proxy-iframe'); if (f) f.src = proxyPageUrl(state.browseUrl); }, innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' }));
      inner.appendChild(h('button', { className: 'icon-btn', title: 'Home', onClick: function() { state.query = ''; exitBrowser(); }, innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' }));
      var addrForm = h('form', { style: { flex: '1', display: 'flex' }, onSubmit: function(e) { e.preventDefault(); var v = this.querySelector('input').value.trim(); if (!v) return; var u = /^https?:\\/\\//i.test(v) ? v : 'https://' + v; openInProxy(u); } });
      var addrInput = h('input', { className: 'address-input', value: state.addressBar, onFocus: function() { this.select(); } });
      addrForm.appendChild(addrInput);
      inner.appendChild(addrForm);
    } else {
      var searchForm = h('form', { style: { flex: '1', display: 'flex', gap: '8px' }, onSubmit: function(e) { e.preventDefault(); handleSubmit(this.querySelector('input').value); } });
      var wrap = h('div', { className: 'search-wrap' });
      wrap.appendChild(h('span', { className: 'search-icon', innerHTML: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' }));
      var searchInput = h('input', { className: 'search-input', placeholder: 'Search or enter a URL\\u2026', value: state.query, autofocus: 'true', onInput: function(e) { state.query = e.target.value; } });
      wrap.appendChild(searchInput);
      searchForm.appendChild(wrap);
      searchForm.appendChild(h('button', { type: 'submit', className: 'search-btn' }, 'Search'));
      inner.appendChild(searchForm);
    }
    header.appendChild(inner);

    if (!state.browseUrl && hasResults) {
      var tabBar = h('div', { className: 'tab-bar' });
      ['web', 'images', 'videos'].forEach(function(t) {
        tabBar.appendChild(h('button', { className: 'tab-btn' + (state.tab === t ? ' active' : ''), onClick: function() { changeTab(t); } }, t));
      });
      header.appendChild(tabBar);
    }
    root.appendChild(header);

    // BROWSER MODE
    if (state.browseUrl) {
      var browserDiv = h('div', { className: 'browser-frame' });
      if (state.iframeLoading) {
        var bar = h('div', { className: 'progress-bar' });
        bar.appendChild(h('div', { className: 'progress-bar-inner' }));
        browserDiv.appendChild(bar);
      }
      var iframe = h('iframe', {
        id: 'proxy-iframe',
        src: proxyPageUrl(state.browseUrl),
        sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals',
        allow: 'fullscreen; autoplay; encrypted-media; picture-in-picture',
        title: 'EzBypass Browser'
      });
      iframe.addEventListener('load', function() {
        state.iframeLoading = false;
        try {
          var src = iframe.contentWindow.location.href;
          if (src) { try { var u = new URL(src); var up = u.searchParams.get('url'); if (up) { state.addressBar = decodeURIComponent(up); state.browseUrl = state.addressBar; } } catch(e){} }
        } catch(e) {}
        render();
      });
      browserDiv.appendChild(iframe);
      root.appendChild(browserDiv);
      return;
    }

    // SEARCH RESULTS
    var main = h('div', { className: 'main' });

    if (!hasResults && !state.loading && !state.error) {
      var landing = h('div', { className: 'landing' });
      landing.appendChild(h('h1', null, 'EzBypass'));
      landing.appendChild(h('p', null, 'Search the web freely or enter a URL \\u2014 no filters, no restrictions.'));
      var tabs = h('div', { className: 'landing-tabs' });
      ['web', 'images', 'videos'].forEach(function(t) {
        tabs.appendChild(h('button', { className: 'landing-tab' + (state.tab === t ? ' active' : ''), onClick: function() { state.tab = t; render(); } }, t));
      });
      landing.appendChild(tabs);
      main.appendChild(landing);
    }

    if (state.loading && !hasResults) {
      var dots = h('div', { className: 'dots' });
      for (var i = 0; i < 3; i++) dots.appendChild(h('div', { className: 'dot' }));
      main.appendChild(dots);
    }

    if (state.error) main.appendChild(h('div', { className: 'error-box' }, state.error));

    if (state.tab === 'web' && state.webResults.length > 0) {
      var container = h('div', { className: 'web-results' });
      state.webResults.forEach(function(r) {
        var card = h('div', { className: 'web-result' });
        card.appendChild(h('div', { className: 'wr-url' }, r.display_url || r.url));
        card.appendChild(h('div', { className: 'wr-title' }, r.title));
        if (r.snippet) card.appendChild(h('div', { className: 'wr-snippet' }, r.snippet));
        var actions = h('div', { className: 'wr-actions' });
        actions.appendChild(h('button', { className: 'wr-open', onClick: function() { openInProxy(r.url); } }, 'Open in proxy'));
        card.appendChild(actions);
        container.appendChild(card);
      });
      main.appendChild(container);
    }

    if (state.tab === 'images' && state.imageResults.length > 0) {
      var grid = h('div', { className: 'img-grid' });
      state.imageResults.forEach(function(img) {
        var card = h('div', { className: 'img-card', onClick: function() { state.lightbox = img; render(); } });
        var imgEl = h('img', { src: proxyImgUrl(img.thumbnail || img.image), alt: img.title || '', loading: 'lazy' });
        imgEl.addEventListener('error', function() { this.outerHTML = '<div class="no-img">No image</div>'; });
        card.appendChild(imgEl);
        grid.appendChild(card);
      });
      main.appendChild(grid);
    }

    if (state.tab === 'videos' && state.videoResults.length > 0) {
      var vgrid = h('div', { className: 'vid-grid' });
      state.videoResults.forEach(function(vid) {
        var thumb = vid.images && (vid.images.large || vid.images.medium || vid.images.small);
        var videoUrl = vid.content || vid.embed_url;
        var card = h('div', { className: 'vid-card', onClick: function() { if (videoUrl) openInProxy(videoUrl); } });
        var thumbDiv = h('div', { className: 'vid-thumb' });
        if (thumb) {
          var tImg = h('img', { src: proxyImgUrl(thumb), alt: vid.title || '' });
          tImg.addEventListener('error', function() { this.style.display = 'none'; });
          thumbDiv.appendChild(tImg);
        }
        var overlay = h('div', { className: 'vid-play-overlay' });
        overlay.appendChild(h('div', { className: 'vid-play-circle', innerHTML: '<svg width="28" height="28" viewBox="0 0 24 24" fill="#000"><polygon points="5 3 19 12 5 21 5 3"/></svg>' }));
        thumbDiv.appendChild(overlay);
        card.appendChild(thumbDiv);
        var meta = h('div', { className: 'vid-meta' });
        meta.appendChild(h('div', { className: 'vid-title' }, vid.title || ''));
        if (vid.publisher || vid.uploader) meta.appendChild(h('div', { className: 'vid-pub' }, vid.publisher || vid.uploader));
        card.appendChild(meta);
        vgrid.appendChild(card);
      });
      main.appendChild(vgrid);
    }

    if (hasResults) {
      var lm = h('div', { className: 'load-more' });
      if (state.loading) {
        var ld = h('div', { className: 'dots' }); for (var di = 0; di < 3; di++) ld.appendChild(h('div', { className: 'dot' })); lm.appendChild(ld);
      } else if (state.hasMore) {
        lm.appendChild(h('button', { className: 'load-more-btn', onClick: loadMore }, 'Load more'));
      } else {
        lm.appendChild(h('span', { style: { fontSize: '13px', color: 'var(--text-mute)' } }, 'No more results'));
      }
      main.appendChild(lm);
    }

    root.appendChild(main);

    // LIGHTBOX
    if (state.lightbox) {
      var lb = h('div', { className: 'lightbox', onClick: function() { state.lightbox = null; render(); } });
      var imgWrap = h('div', { onClick: function(e) { e.stopPropagation(); }, style: { maxWidth: '90vw', maxHeight: '80vh' } });
      imgWrap.appendChild(h('img', { src: proxyImgUrl(state.lightbox.image), alt: state.lightbox.title || '' }));
      lb.appendChild(imgWrap);
      var info = h('div', { className: 'lb-info' });
      info.appendChild(h('span', { className: 'lb-title' }, state.lightbox.title || ''));
      if (state.lightbox.url) {
        info.appendChild(h('button', { className: 'lb-source', onClick: function(e) { e.stopPropagation(); openInProxy(state.lightbox.url); state.lightbox = null; } }, 'Open source'));
      }
      lb.appendChild(info);
      lb.appendChild(h('button', { className: 'lb-close', onClick: function(e) { e.stopPropagation(); state.lightbox = null; render(); } }, '\\u00d7'));
      root.appendChild(lb);
    }

    if (!state.browseUrl) {
      var si = root.querySelector('.search-input');
      if (si && !hasResults) si.focus();
    }
  }

  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && state.lightbox) { state.lightbox = null; render(); } });
  render();
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HOME_HTML);
});
app.use('/api', router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
