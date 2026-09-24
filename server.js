import express from "express";

const app = express();
const router = express.Router();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DDG_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  Connection: "keep-alive",
};

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
  return raw
    .split(/;\s*/g)
    .filter(part => {
      const lower = part.trim().toLowerCase();
      return !lower.startsWith("domain=") && !lower.startsWith("samesite=");
    })
    .join("; ") + "; SameSite=None; Secure";
}

function resolveUrl(base, rel) {
  if (!rel || rel.startsWith("javascript:") || rel.startsWith("data:") || rel.startsWith("blob:") || rel.startsWith("mailto:") || rel.startsWith("tel:") || rel === "#" || rel.startsWith("#")) return null;
  try {
    return new URL(rel, base).href;
  } catch {
    return null;
  }
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
    if(f&&f.action){try{f.action=toProxy(f.action);}catch(err){}}
  },true);
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

router.get("/api/proxy/page", async (req, res) => {
  const targetUrl = String(req.query["url"] || "").trim();
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
  const proxyBase = `${proto}://${host}/api/proxy/page`;
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

// Health check endpoint for Render
app.get('/', (req, res) => res.send('EzBypass Proxy Server is running!'));

app.use(router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
