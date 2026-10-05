/**
 * Runtime feature flags.
 *
 * Document uploads write to ./data, which is read-only on serverless hosts
 * (Render, Vercel, Netlify), so the panel is switched off there and can be
 * re-enabled on a host with a persistent disk.
 */
export const UPLOAD_ENABLED = process.env.NEXT_PUBLIC_UPLOAD_ENABLED === '1';