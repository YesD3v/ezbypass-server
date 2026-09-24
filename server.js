import express from "express";

const app = express();
const router = express.Router();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  
  // Override programmatic form submissions
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

// NEW PATH-BASED ROUTE
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
  // The trailing slash here is critical so URLs append natively
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
  <title>EzBypass Browser</title>
  <style>
    body {
      margin: 0; padding: 0;
      background-color: #000; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100vh;
    }
    .logo {
      width: 80px; height: 80px; fill: #fff;
      filter: drop-shadow(0 0 15px rgba(255,255,255,0.8));
      margin-bottom: 20px;
    }
    h1 { font-weight: 800; letter-spacing: 4px; text-transform: uppercase; margin-bottom: 40px; }
    form { width: 100%; max-width: 600px; padding: 0 20px; box-sizing: border-box; }
    input {
      width: 100%; padding: 18px 25px;
      background: #0a0a0a; border: 1px solid #333;
      color: #fff; border-radius: 30px; font-size: 16px;
      outline: none; transition: 0.3s;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    input:focus { border-color: #fff; box-shadow: 0 0 20px rgba(255,255,255,0.2); }
    .footer { margin-top: 40px; font-size: 12px; color: #555; letter-spacing: 2px; text-transform: uppercase; }
  </style>
</head>
<body>
  <svg class="logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
  <h1>EzBypass</h1>
  <form id="searchForm">
    <input type="text" id="query" placeholder="Search anonymously or enter a URL..." autocomplete="off" autofocus>
  </form>
  <div class="footer">Secure • Anonymous • Untraceable</div>

  <script>
    document.getElementById('searchForm').addEventListener('submit', function(e) {
      e.preventDefault();
      let val = document.getElementById('query').value.trim();
      if (!val) return;
      let target = "";
      if (/^https?:\\/\\//i.test(val)) {
        target = val;
      } else if (val.includes('.') && !val.includes(' ')) {
        target = 'https://' + val;
      } else {
        target = 'https://duckduckgo.com/?q=' + encodeURIComponent(val);
      }
      window.location.href = "/api/proxy/page/" + target;
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
