// Load environment variables from .env before other imports execute.
// RETIRED: business config now lives in ~/.lovdex/data/app.config.json
// (see server/modules/config/). We no longer read a .env file; the only
// remaining env surface is the AUTH_ENABLED safety valve (read in
// auth.config.ts) plus system/process vars (HOME/PATH/SHELL).
