/**
 * Platform mode flag — now sourced from app.config.json (server.isPlatform),
 * not the VITE_IS_PLATFORM environment variable.
 */
import { appConfig } from '../modules/config/config.js';

export const IS_PLATFORM = appConfig().get().server.isPlatform;