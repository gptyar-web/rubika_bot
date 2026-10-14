import { createHandler } from "./lib/handler.js";

const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SCOPE_SALT", "ALLOWED_ORIGINS", "RUBIKA_API_BASE", "ALLOW_LOCALHOST"];
const env = Object.fromEntries(names.map(name => [name, Deno.env.get(name)]));
Deno.serve(createHandler({ env }));
