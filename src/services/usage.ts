import { Credential } from '../storage/credentials.js';

// Request detail for history
export interface RequestDetail {
  timestamp: number;
  accountId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  success: boolean;
  error?: string;
}

// Usage stats for a specific model
export interface ModelStats {
  totalRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  details: RequestDetail[];
}

// Usage stats for a specific credential
export interface CredentialStats {
  accountId: string;
  provider: string;
  totalRequests: number;
  totalTokens: number;
  models: Map<string, ModelStats>;
}

// Daily stats
export interface DailyStats {
  date: string;
  totalRequests: number;
  totalTokens: number;
  byProvider: Map<string, { requests: number; tokens: number }>;
}

// Hourly stats (for today)
export interface HourlyStats {
  hour: number;
  requests: number;
  tokens: number;
}

class UsageStatistics {
  private totalRequests = 0;
  private totalTokens = 0;
  private successCount = 0;
  private failureCount = 0;
  
  // By credential: accountId -> CredentialStats
  private credentialStats = new Map<string, CredentialStats>();
  
  // By day: "YYYY-MM-DD" -> DailyStats
  private dailyStats = new Map<string, DailyStats>();
  
  // By hour for today (0-23)
  private hourlyStats: HourlyStats[] = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    requests: 0,
    tokens: 0,
  }));
  
  // Recent request history (last 1000 requests)
  private maxHistorySize = 1000;
  private requestHistory: RequestDetail[] = [];
  
  // Started time
  private startedAt = Date.now();

  /**
   * Record a request
   */
  recordRequest(
    credential: Credential,
    model: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    },
    success: boolean,
    error?: string
  ): void {
    const now = Date.now();
    const date = new Date(now);
    const dateKey = date.toISOString().split('T')[0];
    const hour = date.getHours();
    
    const accountId = credential.account_id;
    const provider = credential.provider || 'gemini';
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const totalTokens = usage.totalTokens || (inputTokens + outputTokens);

    // Update global stats
    this.totalRequests++;
    this.totalTokens += totalTokens;
    if (success) {
      this.successCount++;
    } else {
      this.failureCount++;
    }

    // Update credential stats
    const credKey = `${accountId}:${provider}`;
    if (!this.credentialStats.has(credKey)) {
      this.credentialStats.set(credKey, {
        accountId,
        provider,
        totalRequests: 0,
        totalTokens: 0,
        models: new Map(),
      });
    }
    const credStats = this.credentialStats.get(credKey)!;
    credStats.totalRequests++;
    credStats.totalTokens += totalTokens;

    // Update model stats within credential
    if (!credStats.models.has(model)) {
      credStats.models.set(model, {
        totalRequests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        details: [],
      });
    }
    const modelStats = credStats.models.get(model)!;
    modelStats.totalRequests++;
    modelStats.totalTokens += totalTokens;
    modelStats.inputTokens += inputTokens;
    modelStats.outputTokens += outputTokens;

    // Update daily stats
    if (!this.dailyStats.has(dateKey)) {
      this.dailyStats.set(dateKey, {
        date: dateKey,
        totalRequests: 0,
        totalTokens: 0,
        byProvider: new Map(),
      });
    }
    const daily = this.dailyStats.get(dateKey)!;
    daily.totalRequests++;
    daily.totalTokens += totalTokens;
    
    if (!daily.byProvider.has(provider)) {
      daily.byProvider.set(provider, { requests: 0, tokens: 0 });
    }
    const providerDaily = daily.byProvider.get(provider)!;
    providerDaily.requests++;
    providerDaily.tokens += totalTokens;

    // Update hourly stats
    this.hourlyStats[hour].requests++;
    this.hourlyStats[hour].tokens += totalTokens;

    // Add to history
    const detail: RequestDetail = {
      timestamp: now,
      accountId,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      success,
      error,
    };
    this.requestHistory.push(detail);
    
    // Trim history if too large
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory = this.requestHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get global stats
   */
  getGlobalStats() {
    return {
      totalRequests: this.totalRequests,
      totalTokens: this.totalTokens,
      successCount: this.successCount,
      failureCount: this.failureCount,
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /**
   * Get stats by credential
   */
  getCredentialStats(): Array<{
    accountId: string;
    provider: string;
    totalRequests: number;
    totalTokens: number;
    models: Array<{
      model: string;
      totalRequests: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  }> {
    return Array.from(this.credentialStats.values()).map((cred) => ({
      accountId: cred.accountId,
      provider: cred.provider,
      totalRequests: cred.totalRequests,
      totalTokens: cred.totalTokens,
      models: Array.from(cred.models.entries()).map(([model, stats]) => ({
        model,
        totalRequests: stats.totalRequests,
        totalTokens: stats.totalTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
      })),
    }));
  }

  /**
   * Get daily stats (last 30 days)
   */
  getDailyStats(days = 30): Array<{
    date: string;
    totalRequests: number;
    totalTokens: number;
    byProvider: Record<string, { requests: number; tokens: number }>;
  }> {
    const result: Array<{
      date: string;
      totalRequests: number;
      totalTokens: number;
      byProvider: Record<string, { requests: number; tokens: number }>;
    }> = [];
    
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      
      const daily = this.dailyStats.get(dateKey);
      if (daily) {
        const byProvider: Record<string, { requests: number; tokens: number }> = {};
        daily.byProvider.forEach((value, key) => {
          byProvider[key] = value;
        });
        
        result.push({
          date: dateKey,
          totalRequests: daily.totalRequests,
          totalTokens: daily.totalTokens,
          byProvider,
        });
      } else {
        result.push({
          date: dateKey,
          totalRequests: 0,
          totalTokens: 0,
          byProvider: {},
        });
      }
    }
    
    return result;
  }

  /**
   * Get today's hourly stats
   */
  getHourlyStats(): HourlyStats[] {
    return this.hourlyStats.map(h => ({ ...h }));
  }

  /**
   * Get recent request history
   */
  getRequestHistory(limit = 100): RequestDetail[] {
    return this.requestHistory.slice(-limit);
  }

  /**
   * Get today's stats for a specific credential
   */
  getTodayStatsForCredential(accountId: string, provider: string): {
    totalRequests: number;
    totalTokens: number;
  } {
    const credKey = `${accountId}:${provider}`;
    const cred = this.credentialStats.get(credKey);
    if (!cred) {
      return { totalRequests: 0, totalTokens: 0 };
    }
    
    // Calculate today's stats from history
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today).getTime();
    
    let todayRequests = 0;
    let todayTokens = 0;
    
    for (const detail of this.requestHistory) {
      if (detail.timestamp >= todayStart && 
          detail.accountId === accountId && 
          detail.provider === provider) {
        todayRequests++;
        todayTokens += detail.totalTokens;
      }
    }
    
    return { totalRequests: todayRequests, totalTokens: todayTokens };
  }

  /**
   * Reset stats (for testing)
   */
  reset(): void {
    this.totalRequests = 0;
    this.totalTokens = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.credentialStats.clear();
    this.dailyStats.clear();
    this.hourlyStats = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      requests: 0,
      tokens: 0,
    }));
    this.requestHistory = [];
    this.startedAt = Date.now();
  }
}

// Singleton instance
const usageStats = new UsageStatistics();

export function getUsageStats(): UsageStatistics {
  return usageStats;
}

export function recordUsage(
  credential: Credential,
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  },
  success: boolean,
  error?: string
): void {
  usageStats.recordRequest(credential, model, usage, success, error);
}
