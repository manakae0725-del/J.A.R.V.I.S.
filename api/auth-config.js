module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    console.error("Supabase public auth configuration is missing");
    return res.status(500).json({ error: "Authentication configuration unavailable" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ url, anonKey });
};
