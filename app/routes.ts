import { type RouteConfig, index, route } from "@react-router/dev/routes";

// The site is a fully static shell — all content comes from Supabase at runtime,
// so there are no server-backed routes in any build.
export default [
  index("routes/home.tsx"),
  route("admin", "routes/admin.tsx"),
  route(":project/search", "routes/search.tsx"),
  route(":project/variables", "routes/variables.tsx"),
  route("*", "routes/wiki.tsx"),
] satisfies RouteConfig;
