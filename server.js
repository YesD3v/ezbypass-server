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
  if(window.__EZPROXY_INJECTED)return;
  window.__EZPROXY_INJECTED=true;
  var PROXY="${proxyBase}";
  var PAGE="${pageUrl}";
  function isProxied(u){
    if(!u||typeof u!=="string")return true;
    try{if(u.startsWith(PROXY)||u.indexOf("/api/proxy/")!==-1)return true;}catch(e){}
    return false;
  }
  function toProxy(u){
    if(!u)return u;
    if(typeof u!=="string")return u;
    try{if(isProxied(u)||u.startsWith("javascript:")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("mailto:")||u.startsWith("#")||u.startsWith("about:"))return u;}catch(e){}
    try{return PROXY+"?url="+encodeURIComponent(new URL(u,PAGE).href);}catch(e){return u;}
  }
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    if(typeof input==="string"&&!isProxied(input)){input=toProxy(input);}
    else if(input&&typeof input==="object"&&input.url&&!isProxied(input.url)){input=new Request(toProxy(input.url),input);}
    return _fetch.call(this,input,init);
  };
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{if(typeof u==="string"&&!isProxied(u))u=toProxy(u);}catch(e){}
    var args=Array.prototype.slice.call(arguments);
    args[1]=u;
    return _open.apply(this,args);
  };
  var _push=history.pushState,_replace=history.replaceState;
  history.pushState=function(s,t,u){try{return _push.call(this,s,t,u?toProxy(u):u);}catch(e){return _push.call(this,s,t,u);}};
  history.replaceState=function(s,t,u){try{return _replace.call(this,s,t,u?toProxy(u):u);}catch(e){return _replace.call(this,s,t,u);}};
  document.addEventListener("click",function(e){
    var el=e.target;
    while(el&&el.tagName!=="A")el=el.parentElement;
    if(!el)return;
    var href=el.getAttribute("href");
    if(!href||href.startsWith("javascript:")||href.startsWith("#"))return;
    if(isProxied(href))return;
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
      if(f.action&&!isProxied(f.action)){try{f.action=toProxy(f.action);}catch(err){}}
    }
  },true);
  var origSubmit=HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit=function(){if(this.action&&!isProxied(this.action)){try{this.action=toProxy(this.action);}catch(e){}}origSubmit.call(this);};
  try{if(window.top!==window){Object.defineProperty(window,"top",{get:function(){return window;}});}}catch(e){}
  try{Object.defineProperty(document,"domain",{get:function(){return location.hostname;},set:function(){}});}catch(e){}
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

// ─── Web proxy ──────────────────────────────────────────────────────────────
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
              thumbnail: obj.turl.replace(/&amp;/g, "&"),
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

// ─── HOME PAGE (original UI + native search rendering) ─────────────────────
const HOME_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EzBypass</title>
  <style>
    body, html {
      margin: 0; padding: 0; height: 100vh;
      background-color: #000; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .bg-container {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 0;
      background: radial-gradient(circle at 50% 50%, #151515 0%, #000 100%);
    }
    .grid {
      position: absolute; width: 200%; height: 200%; top: -50%; left: -50%;
      background-image: linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 50px 50px;
      transform: perspective(600px) rotateX(60deg) translateY(-100px) translateZ(-200px);
      animation: gridMove 15s linear infinite;
    }
    @keyframes gridMove {
      0% { transform: perspective(600px) rotateX(60deg) translateY(0) translateZ(-200px); }
      100% { transform: perspective(600px) rotateX(60deg) translateY(50px) translateZ(-200px); }
    }
    
    .topbar-wrapper {
      position: absolute; top: 15px; left: 0; right: 0;
      display: flex; justify-content: center;
      z-index: 30; pointer-events: none;
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .topbar-wrapper.hidden { transform: translateY(-150%); }
    .topbar {
      pointer-events: auto;
      height: 44px; background: rgba(20, 20, 20, 0.6);
      backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 22px;
      display: flex; align-items: center; padding: 0 12px; gap: 6px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
      width: 90%; max-width: 600px;
      transition: background 0.3s;
    }
    .topbar:hover, .topbar:focus-within { background: rgba(28, 28, 28, 0.85); }
    
    .icon-btn {
      background: transparent; border: none; color: #999;
      cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: 0.2s; padding: 0; flex-shrink: 0;
    }
    .icon-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .icon-btn svg { width: 16px; height: 16px; }
    
    .omnibox-form { flex: 1; display: flex; align-items: center; margin: 0 5px; }
    #omnibox {
      width: 100%; background: transparent; border: none;
      color: #fff; text-align: center; font-size: 14px; outline: none; letter-spacing: 0.5px;
    }
    #omnibox::placeholder { color: #666; }
    
    #browser-frame {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      border: none; background: transparent; z-index: 5; opacity: 0; transition: opacity 0.3s;
    }
    
    .loader {
      display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      gap: 8px; z-index: 20; pointer-events: none;
    }
    .dot {
      width: 12px; height: 12px; background: #fff; border-radius: 50%;
      opacity: 0.2; animation: bounce 1.2s infinite ease-in-out;
    }
    .dot:nth-child(1) { animation-delay: 0s; }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); opacity: 0.2; box-shadow: 0 0 0 rgba(255,255,255,0); }
      50% { transform: translateY(-4px); opacity: 1; box-shadow: 0 0 12px rgba(255,255,255,0.9); }
    }
    
    .welcome {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      text-align: center; pointer-events: none; z-index: 2;
    }
    .welcome h1 { font-weight: 800; letter-spacing: 6px; text-transform: uppercase; margin: 0 0 10px 0; font-size: 32px; color: #fff; text-shadow: 0 0 20px rgba(255,255,255,0.3); }
    .welcome p { color: #666; letter-spacing: 3px; text-transform: uppercase; font-size: 11px; }

    .pull-tab {
      position: absolute; top: 0; left: 50%; transform: translateX(-50%) translateY(-100%);
      width: 80px; height: 18px; background: rgba(20, 20, 20, 0.8);
      backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.1); border-top: none;
      border-radius: 0 0 10px 10px; display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.6); cursor: pointer; z-index: 30;
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s, color 0.2s;
      pointer-events: auto;
    }
    .pull-tab:hover { background: rgba(40, 40, 40, 0.9); color: #fff; }
    .pull-tab.visible { transform: translateX(-50%) translateY(0); }
    .pull-tab svg { width: 16px; height: 16px; margin-top:-4px; }

    /* Search results overlay */
    #search-results {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 10; background: #000; overflow-y: auto; display: none;
      padding: 80px 5vw 40px;
    }
    #search-results .tabs { display: flex; gap: 20px; border-bottom: 1px solid #222; padding-bottom: 12px; margin-bottom: 30px; overflow-x: auto; }
    #search-results .tabs::-webkit-scrollbar { display: none; }
    #search-results .tab { color: #888; text-decoration: none; font-weight: 600; font-size: 15px; position: relative; white-space: nowrap; cursor: pointer; background: none; border: none; font-family: inherit; }
    #search-results .tab:hover { color: #bbb; }
    #search-results .tab.active { color: #fff; }
    #search-results .tab.active::after { content: ''; position: absolute; bottom: -13px; left: 0; right: 0; height: 2px; background: #fff; }
    #search-results .result { margin-bottom: 30px; max-width: 650px; }
    #search-results .result .title { color: #8ab4f8; font-size: 18px; text-decoration: none; display: block; margin-bottom: 6px; font-weight: 500; cursor: pointer; background: none; border: none; font-family: inherit; padding: 0; text-align: left; }
    #search-results .result .title:hover { text-decoration: underline; }
    #search-results .result .url { color: #81c995; font-size: 13px; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #search-results .result .snippet { color: #aaa; font-size: 14px; line-height: 1.5; }
    #search-results .header-logo { color: #fff; font-size: 20px; font-weight: 800; letter-spacing: 2px; margin-bottom: 25px; display: inline-block; cursor: pointer; background: none; border: none; font-family: inherit; }
    #search-results .img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
    #search-results .img-card { border-radius: 8px; overflow: hidden; aspect-ratio: 1/1; cursor: pointer; border: 1px solid #222; transition: transform .15s, border-color .15s; }
    #search-results .img-card:hover { transform: scale(1.03); border-color: #555; }
    #search-results .img-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    #search-results .vid-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    #search-results .vid-card { background: #111; border-radius: 8px; overflow: hidden; cursor: pointer; border: 1px solid #222; transition: transform .15s, border-color .15s; }
    #search-results .vid-card:hover { transform: translateY(-2px); border-color: #555; }
    #search-results .vid-card img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }
    #search-results .vid-card h3 { margin: 0; padding: 10px 12px; font-size: 14px; line-height: 1.4; font-weight: 500; }
    #search-results .load-more { text-align: center; margin-top: 30px; }
    #search-results .load-more button { padding: 10px 28px; background: #111; border: 1px solid #333; border-radius: 8px; color: #aaa; font-size: 14px; cursor: pointer; font-family: inherit; }
    #search-results .load-more button:hover { border-color: #666; color: #fff; }

    /* Lightbox */
    #lightbox { display: none; position: fixed; inset: 0; z-index: 999; background: rgba(0,0,0,0.9); backdrop-filter: blur(8px);
      flex-direction: column; align-items: center; justify-content: center; padding: 24px; gap: 12px; }
    #lightbox img { max-width: 90vw; max-height: 80vh; border-radius: 10px; object-fit: contain; }
    #lightbox .lb-close { position: fixed; top: 16px; right: 16px; width: 36px; height: 36px; border-radius: 50%;
      background: #222; border: 1px solid #444; color: #fff; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    #lightbox .lb-open { padding: 8px 16px; background: #fff; color: #000; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-family: inherit; font-size: 13px; }

    @media (max-width: 600px) {
      .topbar { height: 40px; border-radius: 20px; padding: 0 8px; gap: 4px; width: 95%; }
      .icon-btn { width: 28px; height: 28px; }
      .icon-btn svg { width: 14px; height: 14px; }
      #omnibox { font-size: 13px; }
      .welcome h1 { font-size: 24px; letter-spacing: 4px; }
      .welcome p { font-size: 9px; letter-spacing: 2px; }
      #search-results { padding: 70px 15px 40px; }
      #search-results .img-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      #search-results .vid-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="bg-container"><div class="grid"></div></div>
  
  <div id="pull-tab" class="pull-tab">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
  </div>

  <div class="topbar-wrapper" id="topbar-wrapper">
    <header class="topbar">
      <button id="btn-home" class="icon-btn" title="Home">
        <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polyline points="9 22 9 12 15 12 15 22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="btn-back" class="icon-btn" title="Back">
        <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="btn-forward" class="icon-btn" title="Forward">
        <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="btn-close" class="icon-btn" title="Close" style="margin-right:8px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
      <button id="btn-reload" class="icon-btn" title="Reload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
      </button>
      
      <form id="nav-form" class="omnibox-form">
        <input type="text" id="omnibox" placeholder="Search anonymously or enter URL..." autocomplete="off" autofocus />
      </form>
    </header>
  </div>
  
  <div class="welcome" id="welcome-text">
    <h1>EzBypass</h1>
    <p>Untraceable &bull; Secure &bull; Anonymous</p>
  </div>

  <div class="loader" id="loader">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  </div>

  <iframe id="browser-frame" src="" allow="fullscreen; autoplay; encrypted-media; picture-in-picture" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"></iframe>

  <div id="search-results"></div>

  <div id="lightbox">
    <img id="lb-img" src="" alt="">
    <div style="display:flex;align-items:center;gap:12px;">
      <span id="lb-title" style="font-size:13px;color:#aaa;max-width:500px;text-align:center;"></span>
      <button class="lb-open" id="lb-open">Open source</button>
    </div>
    <button class="lb-close" id="lb-close">&times;</button>
  </div>

  <script>
    const frame = document.getElementById('browser-frame');
    const input = document.getElementById('omnibox');
    const welcome = document.getElementById('welcome-text');
    const loader = document.getElementById('loader');
    const searchResults = document.getElementById('search-results');
    const wrapper = document.getElementById('topbar-wrapper');
    const pullTab = document.getElementById('pull-tab');
    const lightbox = document.getElementById('lightbox');
    const lbImg = document.getElementById('lb-img');
    const lbTitle = document.getElementById('lb-title');
    const lbOpen = document.getElementById('lb-open');
    const lbClose = document.getElementById('lb-close');

    let hideTimeout;
    let historyStack = [];
    let currentIndex = -1;
    let currentTab = 'web';
    let currentQuery = '';
    let currentPage = 1;
    let currentLightboxUrl = '';
    let mode = 'home'; // 'home', 'search', 'browse'

    function proxyImg(url) { return '/api/proxy/image?url=' + encodeURIComponent(url); }
    function proxyPage(url) { return '/api/proxy/page?url=' + encodeURIComponent(url); }

    // Auto-hide topbar
    document.getElementById('btn-close').addEventListener('click', () => {
      clearTimeout(hideTimeout);
      wrapper.classList.add('hidden');
      pullTab.classList.add('visible');
    });

    function resetHideTimer() {
      clearTimeout(hideTimeout);
      wrapper.classList.remove('hidden');
      pullTab.classList.remove('visible');
      if (mode === 'browse') {
        hideTimeout = setTimeout(() => {
          wrapper.classList.add('hidden');
          pullTab.classList.add('visible');
        }, 3500);
      }
    }

    wrapper.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
    wrapper.addEventListener('mouseleave', resetHideTimer);
    pullTab.addEventListener('mouseenter', resetHideTimer);
    input.addEventListener('focus', () => clearTimeout(hideTimeout));
    input.addEventListener('blur', resetHideTimer);
    frame.addEventListener('load', resetHideTimer);

    // Lightbox
    lbClose.addEventListener('click', () => { lightbox.style.display = 'none'; });
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; });
    lbOpen.addEventListener('click', () => { lightbox.style.display = 'none'; openInProxy(currentLightboxUrl); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lightbox.style.display = 'none'; });

    function showLightbox(img) {
      lbImg.src = proxyImg(img.image);
      lbTitle.textContent = img.title || '';
      currentLightboxUrl = img.url || img.image;
      lightbox.style.display = 'flex';
    }

    function setMode(m) {
      mode = m;
      welcome.style.display = m === 'home' ? 'block' : 'none';
      searchResults.style.display = m === 'search' ? 'block' : 'none';
      frame.style.opacity = m === 'browse' ? '1' : '0';
      frame.style.pointerEvents = m === 'browse' ? 'auto' : 'none';
      if (m !== 'browse') frame.src = '';
      if (m === 'home') loader.style.display = 'none';
      resetHideTimer();
    }

    function openInProxy(url) {
      setMode('browse');
      frame.style.opacity = '0';
      loader.style.display = 'flex';
      frame.src = proxyPage(url);
      input.value = url;
      historyStack = historyStack.slice(0, currentIndex + 1);
      historyStack.push(url);
      currentIndex++;
    }

    async function doSearch(q, tab, page, append) {
      if (!append) {
        setMode('search');
        loader.style.display = 'flex';
        searchResults.innerHTML = '';
      }
      currentQuery = q;
      currentTab = tab;
      currentPage = page;
      input.value = q;

      try {
        const res = await fetch('/api/proxy/search?q=' + encodeURIComponent(q) + '&type=' + tab + '&page=' + page);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        const results = data.results || [];

        loader.style.display = 'none';

        if (!append) {
          searchResults.innerHTML = '';
          // Header
          const logo = document.createElement('button');
          logo.className = 'header-logo';
          logo.textContent = 'EzBypass Search';
          logo.onclick = () => setMode('home');
          searchResults.appendChild(logo);

          // Tabs
          const tabs = document.createElement('div');
          tabs.className = 'tabs';
          ['web', 'images', 'videos'].forEach(t => {
            const btn = document.createElement('button');
            btn.className = 'tab' + (t === tab ? ' active' : '');
            btn.textContent = t.charAt(0).toUpperCase() + t.slice(1);
            btn.onclick = () => doSearch(q, t, 1, false);
            tabs.appendChild(btn);
          });
          searchResults.appendChild(tabs);
        }

        // Get or create results container
        let container = searchResults.querySelector('.results-container');
        if (!container || !append) {
          container = document.createElement('div');
          container.className = 'results-container';
          searchResults.appendChild(container);
        }

        if (tab === 'web') {
          results.forEach(r => {
            const div = document.createElement('div');
            div.className = 'result';
            div.innerHTML = '<div class="url">' + (r.display_url || r.url) + '</div><div class="snippet">' + (r.snippet || '') + '</div>';
            const title = document.createElement('button');
            title.className = 'title';
            title.textContent = r.title;
            title.onclick = () => openInProxy(r.url);
            div.prepend(div.querySelector('.url'));
            div.prepend(title);
            container.appendChild(div);
          });
          if (results.length >= 10) addLoadMore(container, q, tab, page + 1);
        } else if (tab === 'images') {
          if (!append) container.className = 'results-container img-grid';
          results.forEach(img => {
            const card = document.createElement('div');
            card.className = 'img-card';
            card.onclick = () => showLightbox(img);
            const imgEl = document.createElement('img');
            imgEl.src = proxyImg(img.thumbnail || img.image);
            imgEl.alt = img.title || '';
            imgEl.loading = 'lazy';
            imgEl.onerror = function() { this.parentElement.style.display = 'none'; };
            card.appendChild(imgEl);
            container.appendChild(card);
          });
          if (results.length >= 40) addLoadMore(searchResults, q, tab, page + 1);
        } else if (tab === 'videos') {
          if (!append) container.className = 'results-container vid-grid';
          results.forEach(vid => {
            const card = document.createElement('div');
            card.className = 'vid-card';
            card.onclick = () => { if (vid.content) openInProxy(vid.content); };
            if (vid.thumbnail) {
              const img = document.createElement('img');
              img.src = proxyImg(vid.thumbnail);
              img.alt = vid.title || '';
              img.loading = 'lazy';
              img.onerror = function() { this.style.display = 'none'; };
              card.appendChild(img);
            }
            const h3 = document.createElement('h3');
            h3.textContent = vid.title || '';
            card.appendChild(h3);
            container.appendChild(card);
          });
          if (results.length >= 25) addLoadMore(searchResults, q, tab, page + 1);
        }

        if (results.length === 0 && !append) {
          container.innerHTML = '<p style="color:#888;text-align:center;padding:40px 0;">No results found.</p>';
        }
      } catch (err) {
        loader.style.display = 'none';
        if (!append) searchResults.innerHTML = '<div style="color:#ff6b6b;text-align:center;padding:60px 20px;">' + err.message + '</div>';
      }
    }

    function addLoadMore(parent, q, tab, nextPage) {
      const div = document.createElement('div');
      div.className = 'load-more';
      const btn = document.createElement('button');
      btn.textContent = 'Load more';
      btn.onclick = () => { div.remove(); doSearch(q, tab, nextPage, true); };
      div.appendChild(btn);
      parent.appendChild(div);
    }

    // Navigation
    document.getElementById('nav-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      if (/^https?:\\/\\//i.test(val)) {
        openInProxy(val);
      } else if (val.includes('.') && !val.includes(' ')) {
        openInProxy('https://' + val);
      } else {
        doSearch(val, currentTab, 1, false);
      }
    });

    document.getElementById('btn-back').addEventListener('click', () => {
      if (currentIndex > 0) { currentIndex--; openInProxy(historyStack[currentIndex]); }
    });
    document.getElementById('btn-forward').addEventListener('click', () => {
      if (currentIndex < historyStack.length - 1) { currentIndex++; openInProxy(historyStack[currentIndex]); }
    });
    document.getElementById('btn-reload').addEventListener('click', () => {
      if (mode === 'browse' && frame.src) {
        frame.style.opacity = '0';
        loader.style.display = 'flex';
        try { frame.contentWindow.location.reload(); } catch(e) { frame.src = frame.src; }
      }
      if (mode === 'home') return;
    });
    document.getElementById('btn-home').addEventListener('click', () => {
      input.value = '';
      setMode('home');
    });

    frame.addEventListener('load', () => {
      if (!frame.src || frame.src === window.location.href) return;
      loader.style.display = 'none';
      frame.style.opacity = '1';
      frame.style.pointerEvents = 'auto';
      try {
        let realUrl = frame.contentWindow.location.href;
        if (realUrl.includes('/api/proxy/page')) {
          try {
            const u = new URL(realUrl);
            const extracted = u.searchParams.get('url');
            if (extracted) input.value = decodeURIComponent(extracted);
          } catch(e) {}
        }
      } catch(e) {}
    });
  </script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HOME_HTML);
});
app.use('/api', router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
