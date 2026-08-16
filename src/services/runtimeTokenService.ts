/**
 * runtimeTokenService.ts - Memory-only runtime token management
 *
 * Fetches temporary API tokens from server for direct client-to-API calls.
 * Tokens are NEVER written to:
 * - settings.json
 * - localStorage
 * - Zustand persisted store
 *
 * Tokens expire based on server-returned expires_in.
 * On expiry, caller must call loadRuntimeConfig() again.
 */

import { serverApi, RuntimeConfig, RuntimeGroupConfig } from './serverApi';
import { useAuthStore } from '../store/useAuthStore';
import { api } from './api';

export interface RuntimeTokenInfo {
  enabled: boolean;
  token: string;
  baseUrl: string;
  expiresAt: number; // Date.now() timestamp
  model?: string;
}

// Module-level memory cache — never persisted
let _config: RuntimeConfig | null = null;
let _loadedAt: number = 0;

function isExpired(): boolean {
  if (!_config) return true;
  // Use the shortest expires_in across all groups
  const minExpires = Math.min(
    _config.image.expires_in || 0,
    _config.agent.expires_in || 0,
    _config.postprocess.expires_in || 0
  );
  if (minExpires <= 0) return true;
  return Date.now() > _loadedAt + minExpires * 1000;
}

function toRuntimeTokenInfo(group: RuntimeGroupConfig): RuntimeTokenInfo {
  return {
    enabled: group.enabled,
    token: group.token,
    baseUrl: group.base_url,
    expiresAt: _loadedAt + (group.expires_in || 0) * 1000,
    model: group.model,
  };
}

/**
 * Load runtime config from server.
 * Only works when user is logged in.
 * Stores result in memory only.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  const { isLoggedIn } = useAuthStore.getState();
  if (!isLoggedIn) return null;

  const config = await serverApi.getRuntimeConfig();
  _config = config;
  _loadedAt = Date.now();

  // Sync to Rust in-memory state (never persisted to disk)
  if (config) {
    try {
      await api.setRuntimeAuthConfig({
        imageToken: config.image.enabled ? config.image.token : '',
        imageBaseUrl: config.image.base_url,
        agentToken: config.agent.enabled ? config.agent.token : '',
        agentBaseUrl: config.agent.base_url,
        postprocessToken: config.postprocess.enabled ? config.postprocess.token : '',
        postprocessBaseUrl: config.postprocess.base_url,
      });
    } catch {
      // Rust command failed — frontend memory cache still works for UI checks
    }
  }

  return config;
}

/**
 * Get runtime token info for image generation.
 * Auto-reloads if expired.
 */
export async function getRuntimeImageConfig(): Promise<RuntimeTokenInfo> {
  if (isExpired() || !_config) {
    await loadRuntimeConfig();
  }
  if (!_config) return { enabled: false, token: '', baseUrl: '', expiresAt: 0 };
  return toRuntimeTokenInfo(_config.image);
}

/**
 * Get runtime token info for agent/chat.
 * Auto-reloads if expired.
 */
export async function getRuntimeAgentConfig(): Promise<RuntimeTokenInfo> {
  if (isExpired() || !_config) {
    await loadRuntimeConfig();
  }
  if (!_config) return { enabled: false, token: '', baseUrl: '', expiresAt: 0 };
  return toRuntimeTokenInfo(_config.agent);
}

/**
 * Get runtime token info for postprocess (remove.bg etc).
 * Auto-reloads if expired.
 */
export async function getRuntimePostprocessConfig(): Promise<RuntimeTokenInfo> {
  if (isExpired() || !_config) {
    await loadRuntimeConfig();
  }
  if (!_config) return { enabled: false, token: '', baseUrl: '', expiresAt: 0 };
  return toRuntimeTokenInfo(_config.postprocess);
}

/**
 * Clear all cached runtime tokens.
 * Called on logout.
 */
export function clearRuntimeConfig(): void {
  _config = null;
  _loadedAt = 0;
  // Clear Rust in-memory state
  api.clearRuntimeAuthConfig().catch(() => {});
}

/**
 * Check if runtime config is loaded and not expired.
 */
export function isRuntimeConfigReady(): boolean {
  return _config !== null && !isExpired();
}

/**
 * Get the cached config without reloading.
 * Returns null if not loaded or expired.
 */
export function getCachedConfig(): RuntimeConfig | null {
  if (isExpired()) return null;
  return _config;
}
