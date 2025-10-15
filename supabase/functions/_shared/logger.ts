import type { SupabaseClient } from "@supabase/supabase-js";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogPayload {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

// Legacy function for backwards compatibility
export async function logEvent(
  client: SupabaseClient,
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await client.from("logs").insert({
      level,
      message,
      context,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[logEvent] fallback", { level, message, context, error });
  }
}

export function buildLogContext(
  payload: LogPayload,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    level: payload.level,
    message: payload.message,
    ...(payload.context ?? {}),
    ...(extras ?? {}),
  };
}

// Structured logging schema
interface LogEntry {
  timestamp: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  correlationId?: string;
  invocationId: string | null;
  functionName: string;
  source: string;
  action: string;
  durationMs?: number;
  success?: boolean;
  message: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  payload?: Record<string, unknown>;
}

// Mask sensitive data in logs
function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['access_token', 'refresh_token', 'password', 'secret', 'key', 'token'];
  const maskedData = {...data};
  for (const key in maskedData) {
    if (sensitiveKeys.includes(key.toLowerCase()) && typeof maskedData[key] === 'string') {
      maskedData[key] = '***MASKED***';
    }
  }
  return maskedData;
}

// Enhanced structured logger class
export class Logger {
  private functionName: string;
  private correlationId?: string;

  constructor(functionName: string, correlationId?: string) {
    this.functionName = functionName;
    this.correlationId = correlationId;
  }

  private log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', logData: Partial<LogEntry> & { message: string }) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      severity: level,
      correlationId: this.correlationId,
      invocationId: Deno.env.get('SB_EXECUTION_ID') ?? null,
      functionName: this.functionName,
      source: logData.source || 'default',
      action: logData.action || 'log',
      message: logData.message,
      durationMs: logData.durationMs,
      success: logData.success,
      error: logData.error,
      payload: logData.payload ? maskSensitiveData(logData.payload) : undefined,
    };
    console.log(JSON.stringify(entry));
  }

  info(message: string, data: Omit<Partial<LogEntry>, 'severity' | 'message'> = {}) {
    this.log('INFO', { message, ...data });
  }

  warn(message: string, data: Omit<Partial<LogEntry>, 'severity' | 'message'> = {}) {
    this.log('WARN', { message, ...data });
  }

  error(message: string, error: Error, data: Omit<Partial<LogEntry>, 'severity' | 'message'> = {}) {
    this.log('ERROR', {
      message,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      success: false,
      ...data,
    });
  }

  debug(message: string, data: Omit<Partial<LogEntry>, 'severity' | 'message'> = {}) {
    this.log('DEBUG', { message, ...data });
  }
}