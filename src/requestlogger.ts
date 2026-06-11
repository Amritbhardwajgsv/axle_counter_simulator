import { Request, RequestHandler } from "express";
import { IncomingMessage } from "node:http";

type LogDetails = Record<string, boolean | number | string | undefined>;

export function requestLogger(): RequestHandler {
    return (request, response, next) => {
        const startedAt = Date.now();

        response.on("finish", () => {
            logRequest({
                protocol: "http",
                ip: getRequestIp(request),
                purpose: `${request.method} ${request.originalUrl}`,
                outcome: String(response.statusCode),
                durationMs: Date.now() - startedAt,
            });
        });

        next();
    };
}

export function getRequestIp(request: IncomingMessage): string {
    const forwardedFor = request.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor;
    const forwardedIp = forwardedValue?.split(",")[0]?.trim();

    return normalizeIp(forwardedIp || request.socket.remoteAddress || "unknown");
}

export function logRequest(details: {
    protocol: "http" | "websocket";
    ip: string;
    purpose: string;
    outcome: string;
    durationMs?: number;
    metadata?: LogDetails;
}): void {
    console.log(
        JSON.stringify({
            type: "request",
            timestamp: new Date().toISOString(),
            ...details,
            metadata: removeUndefined(details.metadata),
        }),
    );
}

function normalizeIp(ip: string): string {
    return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function removeUndefined(
    details: LogDetails | undefined,
): LogDetails | undefined {
    if (!details) {
        return undefined;
    }

    return Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== undefined),
    );
}
