#!/usr/bin/env node

// Compatibility entrypoint. The active collector uses an in-memory anonymous
// visitor session and never reads a browser or account cookie.
import "./collect_comments_api.mjs";
