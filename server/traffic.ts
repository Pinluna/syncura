import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface TrafficEvent {
  at: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes: number;
}

interface TrafficBucket {
  minute: string;
  requests: number;
  errors: number;
  responseBytes: number;
}

const startedAt = new Date().toISOString();
const recent: TrafficEvent[] = [];
const buckets: TrafficBucket[] = [];
let totalRequests = 0;
let totalErrors = 0;
let totalResponseBytes = 0;
let totalConnections = 0;
let totalDisconnections = 0;

function minuteKey(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()).toISOString();
}

function currentBucket(date = new Date()): TrafficBucket {
  const minute = minuteKey(date);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.minute !== minute) {
    bucket = { minute, requests: 0, errors: 0, responseBytes: 0 };
    buckets.push(bucket);
    if (buckets.length > 60) buckets.splice(0, buckets.length - 60);
  }
  return bucket;
}

function safePath(req: Request): string {
  const route = req.route?.path;
  if (typeof route === "string") return `${req.baseUrl}${route}`.slice(0, 180);
  return req.path
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id")
    .replace(/\/\d{5,}(?=\/|$)/g, "/:id")
    .slice(0, 180);
}

export function trackTraffic(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/__local/traffic") {
    next();
    return;
  }

  const start = performance.now();
  res.once("finish", () => {
    const now = new Date();
    const responseBytes = Number(res.getHeader("content-length")) || 0;
    const isError = res.statusCode >= 400;
    const event: TrafficEvent = {
      at: now.toISOString(),
      method: req.method,
      path: safePath(req),
      status: res.statusCode,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      responseBytes,
    };
    totalRequests += 1;
    totalErrors += isError ? 1 : 0;
    totalResponseBytes += responseBytes;
    recent.push(event);
    if (recent.length > 40) recent.shift();
    const bucket = currentBucket(now);
    bucket.requests += 1;
    bucket.errors += isError ? 1 : 0;
    bucket.responseBytes += responseBytes;
  });
  next();
}

export function recordSocketConnection(connected: boolean) {
  if (connected) totalConnections += 1;
  else totalDisconnections += 1;
}

export function trafficSnapshot(activeSockets: number) {
  currentBucket();
  return {
    startedAt,
    capturedAt: new Date().toISOString(),
    totals: {
      requests: totalRequests,
      errors: totalErrors,
      responseBytes: totalResponseBytes,
      connections: totalConnections,
      disconnections: totalDisconnections,
    },
    activeSockets,
    buckets: buckets.map((bucket) => ({ ...bucket })),
    recent: [...recent].reverse(),
  };
}

export function validControlToken(candidate: string | undefined, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}
