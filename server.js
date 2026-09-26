import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = "https://f16a23b9-eed5-472d-bd4c-9c038790ec6d-00-xmrhcerqbghn.janeway.replit.dev";

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EzBypass - Offline</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap');
  body {
    margin: 0; padding: 0; height: 100vh; width: 100vw;
    background-color: #000; color: #fff;
    font-family: 'Space Grotesk', -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .bg-container {
    position: absolute; inset: 0; z-index: 0;
    background: radial-gradient(circle at 50% 50%, #151515 0%, #000 100%);
  }
  .grid-bg {
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
  .content {
    position: relative; z-index: 10; text-align: center;
  }
  h1 {
    font-weight: 800; letter-spacing: 6px; text-transform: uppercase;
    margin: 0 0 10px 0; font-size: 32px; color: #fff;
    text-shadow: 0 0 20px rgba(255,255,255,0.3);
  }
  p {
    color: #ff4757; letter-spacing: 3px; text-transform: uppercase;
    font-size: 13px; margin: 0; font-weight: 600;
  }
</style>
</head>
<body>
  <div class="bg-container"><div class="grid-bg"></div></div>
  <div class="content">
    <h1>EzBypass</h1>
    <p>Server Offline</p>
  </div>
</body>
</html>`;

app.use(async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const checkRes = await fetch(TARGET, { signal: controller.signal });
    clearTimeout(timeout);
    
    const text = await checkRes.text();
    const lowerText = text.toLowerCase();
    
    // Check if the response is Replit's offline page
    if (lowerText.includes("run this app") || lowerText.includes("run this repl") || lowerText.includes("replit.com")) {
      // Replit is sleeping/offline
      return res.status(503).send(OFFLINE_HTML);
    }
    
    // Server is online, redirect user
    // Using 302 Temporary Redirect so it checks again on the next visit
    res.redirect(302, TARGET + req.originalUrl);
  } catch (err) {
    // Timeout or network error
    res.status(503).send(OFFLINE_HTML);
  }
});

app.listen(PORT, () => console.log(`Redirect server running on port ${PORT}, forwarding to ${TARGET}`));
