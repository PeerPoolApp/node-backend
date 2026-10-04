/**
 * Supabase client factory for the Node backend.
 *
 * Layer: service. Two clients with different privilege levels:
 * - `supabaseAuth` — publishable key; Auth API only (signUp, signIn, getUser)
 * - `supabaseAdmin` — secret key; bypasses RLS for server-side DML and Storage
 *
 * Neither client auto-refreshes or persists sessions (stateless server).
 */

import {createClient} from '@supabase/supabase-js'
import {config} from '../config.js'

/**
 * Low-privilege Supabase client (publishable key).
 *
 * @auth supabaseAuth — safe for token validation and password auth
 * @pre `config.supabaseUrl` and `config.supabasePublishableKey` are set
 * @post Client with `autoRefreshToken: false`, `persistSession: false`
 */
export const supabaseAuth = createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    },
)

/**
 * Elevated Supabase client (secret / service_role key).
 *
 * @auth supabaseAdmin — server-only; never expose to browser
 * @pre `config.supabaseUrl` and `config.supabaseSecretKey` are set
 * @post Client bypasses RLS; used for profiles, messaging, Storage admin ops
 */
export const supabaseAdmin = createClient(
    config.supabaseUrl,
    config.supabaseSecretKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    },
)
