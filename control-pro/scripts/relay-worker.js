// Optional JavaScript CORS relay. Deploy separately; GitHub Pages does not execute this file.
// Required Worker secrets: ACCESS_KEY (>=32 chars), ALLOWED_ORIGIN (exact Pages origin).
import { METHODS } from "../js/api.js";
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN)
      return new Response("Forbidden", { status: 403 });
    const cors = {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: cors });
    if (
      !env.ACCESS_KEY ||
      env.ACCESS_KEY.length < 32 ||
      !equal(
        request.headers.get("Authorization") || "",
        "Bearer " + env.ACCESS_KEY,
      )
    )
      return new Response("Unauthorized", { status: 401, headers: cors });
    try {
      if (Number(request.headers.get("Content-Length") || 0) > 65536)
        return new Response("Too large", { status: 413, headers: cors });
      const reader = request.body?.getReader();
      if (!reader) throw new Error();
      let size = 0,
        chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          return new Response("Too large", { status: 413, headers: cors });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let pos = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, pos);
        pos += chunk.length;
      }
      const { token, method, payload } = JSON.parse(
        new TextDecoder().decode(bytes),
      );
      if (
        typeof token !== "string" ||
        !token ||
        token.length > 512 ||
        /[\s/?#]/.test(token) ||
        !METHODS.has(method) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      )
        throw new Error();
      const upstream = await fetch(
        "https://botapi.rubika.ir/v3/" +
          encodeURIComponent(token) +
          "/" +
          method,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(18000),
        },
      );
      const content = await upstream.text();
      return new Response(content, {
        status: upstream.status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ status: "ERROR" }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
function equal(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
