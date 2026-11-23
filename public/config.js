// ============================================================================
// SiteClone Frontend -> Backend Configuration
// ============================================================================
// The Vercel frontend talks to the Render backend below.
// Leave BACKEND_URL empty ('') if server.js serves this frontend itself (same server / localhost).
//
// SUPABASE_ANON_KEY is the *public* key (safe in the browser): it can only sign people in.
// The database is locked with row-level security and all writes go through the backend.
window.SITECLONE_CONFIG = {
  BACKEND_URL: 'https://siteclone-pro-1.onrender.com',
  SUPABASE_URL: 'https://isioxmghvetyyymioopa.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzaW94bWdodmV0eXl5bWlvb3BhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MDg1MTQsImV4cCI6MjExMDk4NDUxNH0.23EaW9XI15kXyXE4A59M3SYmn5_vCtit8UosOeRK1Nc',
};
