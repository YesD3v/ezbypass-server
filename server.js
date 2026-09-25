import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = "https://f16a23b9-eed5-472d-bd4c-9c038790ec6d-00-xmrhcerqbghn.janeway.replit.dev";

app.use((req, res) => {
  // 301 Permanent Redirect to the new Replit host, preserving the path and query parameters
  res.redirect(301, TARGET + req.originalUrl);
});

app.listen(PORT, () => console.log(`Redirect server running on port ${PORT}, forwarding to ${TARGET}`));
