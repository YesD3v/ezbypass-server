import express from "express";

const app = express();
const router = express.Router();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function getVqd(query) {
  try {
    const fetchUrl = "https://duckduckgo.com/?q=" + encodeURIComponent(query) + "&ia=web";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(fetchUrl), { headers: { "User-Agent": UA }, signal: controller.signal });
    clearTimeout(timeout);
    const html = await res.text();
    const match = html.match(/vqd=['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const SKIP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
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
  return `${proxyBase}${targetUrl}`;
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
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, q, url) => {
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
    try{return PROXY + new URL(u,PAGE).href;}catch(e){return u;}
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
    if(!f.method || f.method.toUpperCase()==="GET"){
      e.preventDefault();
      try{
        var targetUrl = new URL(f.action || PAGE, PAGE);
        var formData = new FormData(f);
        for(var pair of formData.entries()){
          targetUrl.searchParams.append(pair[0], pair[1]);
        }
        window.location.href = toProxy(targetUrl.href);
      }catch(err){}
    }else{
      if(f.action){try{f.action=toProxy(f.action);}catch(err){}}
    }
  },true);
  
  var originalSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    if(this.action) { try { this.action = toProxy(this.action); } catch(e){} }
    originalSubmit.call(this);
  };

  try{if(window.top!==window){Object.defineProperty(window,"top",{get:function(){return window;}});}}catch(e){}
})();
</script>`;
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

  html = html.replace(/(<meta\b[^>]*?\shttp-equiv=["']refresh["'][^>]*?\scontent=["'])([^"']*)(")/gi, (match, pre, content, close) => {
    return pre + content.replace(/url=([^;'"]+)/i, (m, u) => {
      const resolved = resolveUrl(pageUrl, u);
      return resolved ? `url=${toProxy(resolved, proxyBase)}` : m;
    }) + close;
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
  } finally {
    reader.releaseLock();
  }
  res.end();
}

// Custom Search Engine Route (Using Anti-Bot resilient POST API)
router.get("/api/search", async (req, res) => {
  const query = req.query.q;
  const type = req.query.type || 'web';
  if (!query) return res.send("No query provided.");
  
  try {
    let resultsHTML = "";
    
    if (type === 'web') {
      const ddgRes = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent("https://html.duckduckgo.com/html/?q=" + query), {
        headers: { "User-Agent": UA }
      });
      const html = await ddgRes.text();
      
      const resultRegex = /<h2 class="result__title">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultRegex.exec(html)) !== null) {
        let rawLink = match[1];
        if (rawLink.includes('uddg=')) {
          try {
            let urlParam = new URL("https:" + rawLink).searchParams.get('uddg');
            if (urlParam) rawLink = decodeURIComponent(urlParam);
          } catch(e){}
        }
        if (rawLink.startsWith('/')) rawLink = "https://duckduckgo.com" + rawLink;
        
        const title = match[2].replace(/<[^>]+>/g, '');
        const snippet = match[3].replace(/<[^>]+>/g, '');
        const proxiedLink = "/api/proxy/page/" + rawLink;
        
        resultsHTML += `
          <div class="result">
            <a href="${proxiedLink}" class="title">${title}</a>
            <div class="url">${rawLink}</div>
            <div class="snippet">${snippet}</div>
          </div>
        `;
      }
    
    } else if (type === 'images') {
      try {
        const url = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&adlt=off';
        const bingRes = await fetch(url, { headers: { "User-Agent": UA, "Cookie": "SRCHHPGUSR=ADLT=OFF;" } });
        const html = await bingRes.text();
        
        const matches = [...html.matchAll(/m="({.*?})"/g)];
        let items = [];
        for (let i = 0; i < Math.min(30, matches.length); i++) {
          try {
            let obj = JSON.parse(matches[i][1].replace(/&quot;/g, '"'));
            if (obj.murl && obj.turl) items.push(obj);
          } catch(e) {}
        }
        
        if (items.length > 0) {
          resultsHTML = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px;">';
          for (let item of items) {
            const proxyUrl = '/api/proxy/page?url=' + encodeURIComponent(item.purl);
            resultsHTML += `
              <a href="${proxyUrl}" style="display: block; overflow: hidden; border-radius: 8px;">
                <img src="${item.turl.replace('&amp;', '&')}" style="width: 100%; height: auto; border-radius: 8px; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              </a>
            `;
          }
          resultsHTML += '</div>';
        }
      } catch (err) {
        console.error("Image search error:", err);
      }


    } else if (type === 'videos') {
      try {
        const url = 'https://www.bing.com/videos/search?q=' + encodeURIComponent(query) + '&adlt=off';
        const bingRes = await fetch(url, { headers: { "User-Agent": UA, "Cookie": "SRCHHPGUSR=ADLT=OFF;" } });
        const html = await bingRes.text();
        
        const matches = [...html.matchAll(/mmeta="({.*?})"[^>]*><a aria-label="([^"]+)"/g)];
        let items = [];
        for (let i = 0; i < Math.min(30, matches.length); i++) {
          try {
            let obj = JSON.parse(matches[i][1].replace(/&quot;/g, '"'));
            if (obj.murl && obj.turl) {
              obj.title = matches[i][2].replace(/&#39;/g, "'").split(' &#183; ')[0] || "Video Result";
              items.push(obj);
            }
          } catch(e) {}
        }
        
        if (items.length > 0) {
          resultsHTML = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">';
          for (let item of items) {
            const proxyUrl = '/api/proxy/page?url=' + encodeURIComponent(item.murl);
            resultsHTML += `
              <a href="${proxyUrl}" style="text-decoration: none; color: white;">
                <div style="padding:10px; background:#111; border-radius:8px; height: 100%; display: flex; flex-direction: column;">
                  <img src="${item.turl.replace('&amp;', '&')}" style="width:100%; border-radius:4px; margin-bottom: 8px; object-fit: cover; aspect-ratio: 16/9;">
                  <h3 style="margin: 0; font-size:14px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${item.title}</h3>
                </div>
              </a>
            `;
          }
          resultsHTML += '</div>';
        }
      } catch (err) {
        console.error("Video search error:", err);
      }

    }

    if (!resultsHTML) {
      if (type === 'web') {
        return res.redirect("/api/proxy/page/https://www.google.com/search?q=" + encodeURIComponent(query));
      } else {
        if (type === "images") return res.redirect("/api/proxy/page?url=" + encodeURIComponent("https://www.google.com/search?tbm=isch&q=" + query));
        if (type === "videos") return res.redirect("/api/proxy/page?url=" + encodeURIComponent("https://www.google.com/search?tbm=vid&q=" + query));
      }
    }

    const page = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${query} - EzBypass Search</title>
      <style>
        body { background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 30px 5vw; margin:0; }
        .tabs { display: flex; gap: 20px; border-bottom: 1px solid #222; padding-bottom: 12px; margin-bottom: 30px; overflow-x: auto; }
        .tabs::-webkit-scrollbar { display: none; }
        .tab { color: #888; text-decoration: none; font-weight: 600; font-size: 15px; position: relative; white-space: nowrap; }
        .tab:hover { color: #bbb; }
        .tab.active { color: #fff; }
        .tab.active::after { content: ''; position: absolute; bottom: -13px; left: 0; right: 0; height: 2px; background: #fff; }
        
        .result { margin-bottom: 30px; max-width: 650px; }
        .result .title { color: #8ab4f8; font-size: 18px; text-decoration: none; display: block; margin-bottom: 6px; font-weight: 500; }
        .result .title:hover { text-decoration: underline; }
        .result .url { color: #81c995; font-size: 13px; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .result .snippet { color: #aaa; font-size: 14px; line-height: 1.5; }
        
        .header-logo { color: #fff; font-size: 20px; font-weight: 800; letter-spacing: 2px; margin-bottom: 25px; display: inline-block; text-decoration: none; }
        
        @media (max-width: 600px) {
          body { padding: 20px 15px; }
          .result .title { font-size: 16px; }
          .result .snippet { font-size: 13px; }
        }
      </style>
    </head>
    <body>
      <a href="#" class="header-logo">EzBypass Search</a>
      <div class="tabs">
        <a href="/api/search?q=${encodeURIComponent(query)}&type=web" class="tab ${type === 'web' ? 'active' : ''}">Web</a>
        <a href="/api/search?q=${encodeURIComponent(query)}&type=images" class="tab ${type === 'images' ? 'active' : ''}">Images</a>
        <a href="/api/search?q=${encodeURIComponent(query)}&type=videos" class="tab ${type === 'videos' ? 'active' : ''}">Videos</a>
      </div>
      <div class="results">
        ${resultsHTML}
      </div>
    </body>
    </html>`;
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(page);
  } catch (err) {
    // Return explicit visual error on black screen so it's not purely black
    res.status(500).send(`<html style="background:#000;color:#fff;"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="padding:40px;font-family:sans-serif;"><h2>Search Engine Error</h2><p style="color:#ff6b6b;">${err.message}</p></body></html>`);
  }
});

router.get(["/api/proxy/page", "/api/proxy/page/*"], async (req, res) => {
  const PREFIX = "/api/proxy/page/";
  let targetUrl = "";

  const idx = req.originalUrl.indexOf(PREFIX);
  if (idx !== -1) {
    targetUrl = req.originalUrl.substring(idx + PREFIX.length);
  } else if (req.query.url) {
    targetUrl = String(req.query.url);
  }
  
  if (!targetUrl) { res.status(400).send("Missing url"); return; }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.status(400).send("Invalid URL"); return;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    res.status(400).send("Only http/https supported"); return;
  }

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost";
  const proxyBase = `${proto}://${host}/api/proxy/page/`;
  const browserCookies = req.headers["cookie"];

  try {
    const fetchRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Referer: parsed.origin,
        ...(browserCookies ? { Cookie: browserCookies } : {}),
      },
      redirect: "follow",
    });

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
    res.status(502).send(`<html><body><h2>Proxy error</h2><p>${String(err)}</p></body></html>`);
  }
});

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
      z-index: 10; pointer-events: none;
    }
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

    
      .topbar-wrapper {
        transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .topbar-wrapper.hidden {
        transform: translateY(-150%);
      }
      .pull-tab {
        position: absolute; top: 0; left: 50%; transform: translateX(-50%) translateY(-100%);
        width: 80px; height: 18px; background: rgba(20, 20, 20, 0.8);
        backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
        border: 1px solid rgba(255, 255, 255, 0.1); border-top: none;
        border-radius: 0 0 10px 10px; display: flex; align-items: center; justify-content: center;
        color: rgba(255,255,255,0.6); cursor: pointer; z-index: 10;
        transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s, color 0.2s;
      }
      .pull-tab:hover {
        background: rgba(40, 40, 40, 0.9); color: #fff;
      }
      .pull-tab.visible {
        transform: translateX(-50%) translateY(0);
      }
      .pull-tab svg { width: 16px; height: 16px; margin-top:-4px; }

      /* Mobile Compatibility */
    @media (max-width: 600px) {
      .topbar { height: 40px; border-radius: 20px; padding: 0 8px; gap: 4px; width: 95%; }
      .icon-btn { width: 28px; height: 28px; }
      .icon-btn svg { width: 14px; height: 14px; }
      #omnibox { font-size: 13px; }
      .welcome h1 { font-size: 24px; letter-spacing: 4px; }
      .welcome p { font-size: 9px; letter-spacing: 2px; }
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
      <button id="btn-close" class="icon-btn" title="Close" style="margin-right:8px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
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
    <p>Untraceable • Secure • Anonymous</p>
  </div>

  <div class="loader" id="loader">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  </div>

  <iframe id="browser-frame" src="" allow="fullscreen; autoplay; encrypted-media; picture-in-picture"></iframe>

  <script>
    const frame = document.getElementById('browser-frame');
    const input = document.getElementById('omnibox');
    const welcome = document.getElementById('welcome-text');
    const loader = document.getElementById('loader');
    
      // Auto-hide topbar logic
      const wrapper = document.getElementById('topbar-wrapper');
      const pullTab = document.getElementById('pull-tab');
      const btnClose = document.getElementById('btn-close');
      if(btnClose) btnClose.addEventListener('click', () => {
        clearTimeout(hideTimeout);
        wrapper.classList.add('hidden');
        pullTab.classList.add('visible');
      });
      let hideTimeout;
      
      function resetHideTimer() {
        clearTimeout(hideTimeout);
        wrapper.classList.remove('hidden');
        pullTab.classList.remove('visible');
        
        // Only auto-hide if a page is actually loaded (opacity 1)
        if (frame.style.opacity == 1 || frame.style.opacity === "1") {
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
      
      // Override frame load to trigger the hide timer
      frame.addEventListener('load', () => {
        resetHideTimer();
      });

      let historyStack = [];
    let currentIndex = -1;

    function loadUrl(val, addToHistory=true) {
      if (!val) return;
      let target = "";
      
      if (/^https?:\\/\\//i.test(val)) {
        target = "/api/proxy/page/" + val;
      } else if (val.includes('.') && !val.includes(' ')) {
        target = "/api/proxy/page/https://" + val;
      } else {
        target = "/api/search?q=" + encodeURIComponent(val);
      }
      
      input.value = val;
      frame.src = target;
      
      input.blur();
      welcome.style.display = 'none';
      frame.style.opacity = '0';
      loader.style.display = 'flex';
      
      if (addToHistory) {
        historyStack = historyStack.slice(0, currentIndex + 1);
        historyStack.push(val);
        currentIndex++;
      }
    }

    document.getElementById('nav-form').addEventListener('submit', (e) => {
      e.preventDefault();
      loadUrl(input.value);
    });

    document.getElementById('btn-back').addEventListener('click', () => {
      if (currentIndex > 0) { currentIndex--; loadUrl(historyStack[currentIndex], false); }
    });
    document.getElementById('btn-forward').addEventListener('click', () => {
      if (currentIndex < historyStack.length - 1) { currentIndex++; loadUrl(historyStack[currentIndex], false); }
    });
    document.getElementById('btn-reload').addEventListener('click', () => {
      // Do not allow reload on home page
      if (welcome.style.display !== 'none') return;
      
      if (frame.src && frame.contentWindow) {
        frame.style.opacity = '0';
        loader.style.display = 'flex';
        try {
          frame.contentWindow.location.reload();
        } catch(e) {
          frame.src = frame.src;
        }
      }
    });
    document.getElementById('btn-home').addEventListener('click', () => {
      frame.src = "";
      input.value = "";
      welcome.style.display = 'block';
      frame.style.opacity = '0';
      loader.style.display = 'none';
      historyStack.push("");
      currentIndex++;
    });

    frame.addEventListener('load', () => {
      if (!frame.src || frame.src === window.location.href) return;
      loader.style.display = 'none';
      frame.style.opacity = '1';
      
      try {
        let realUrl = frame.contentWindow.location.href;
        
        if (realUrl.includes('/api/proxy/page/')) {
          let extracted = realUrl.substring(realUrl.indexOf('/api/proxy/page/') + 16);
          input.value = decodeURIComponent(extracted);
          frame.style.background = '#fff';
        } else if (realUrl.includes('/api/search')) {
          let q = new URLSearchParams(frame.contentWindow.location.search).get('q');
          input.value = q || "";
          frame.style.background = '#000';
        }
      } catch(e) {}
    });
  </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HOME_HTML));
app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
