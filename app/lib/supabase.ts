import { createClient } from "@supabase/supabase-js";
import { wikiConfig } from "~/wiki.config";

/**
 * The browser client, authenticated with the publishable key. It is meant to be
 * public — row level security decides what this client may read and write, so
 * an anonymous visitor never receives a private row in the first place.
 */
export const supabase = createClient(wikiConfig.supabase.url, wikiConfig.supabase.publishableKey);
