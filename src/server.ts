import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { SimulationEngine } from "./engine/simulationengine";
import {
    getRequestIp,
    logRequest,
    requestLogger,
} from "./requestlogger";
import {
    ClientMessage,
    ServerMessage,
    STATION_ROUTES,
    StationRoute,
} from "./protocol";

const PORT = Number(process.env.PORT ?? 8081);
const MAX_AXLE_COUNT = 64;
const engine = new SimulationEngine();
const app = express();
const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
let activeRoute: StationRoute | null = null;
let activeSectionName: string | null = null;

const frontendDirectory = path.resolve(process.cwd(), "frontend", "dist");
app.use(requestLogger());
app.get("/health", (_request, response) => {
    response.status(200).json({
        status: "ok",
        lifecycle: engine.getState().systemLifecycle,
    });
});
app.use(express.static(frontendDirectory));
app.use((_request, response) => {
    response.sendFile(path.join(frontendDirectory, "index.html"));
});

function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function broadcast(message: ServerMessage): void {
    for (const client of webSocketServer.clients) {
        send(client, message);
    }
}

engine.subscribe((state) => {
    broadcast({ type: "STATE_SNAPSHOT", state });
});

webSocketServer.on("connection", (socket, request) => {
    const clientIp = getRequestIp(request);
    logRequest({
        protocol: "websocket",
        ip: clientIp,
        purpose: "CONNECT /ws",
        outcome: "connected",
    });

    send(socket, { type: "STATE_SNAPSHOT", state: engine.getState() });

    socket.on("message", async (data) => {
        let message: ClientMessage;
        const startedAt = Date.now();

        try {
            message = parseClientMessage(data.toString());
            await handleMessage(socket, message);
            logRequest({
                protocol: "websocket",
                ip: clientIp,
                purpose: message.type,
                outcome: "accepted",
                durationMs: Date.now() - startedAt,
                metadata: getMessageLogMetadata(message),
            });
        } catch (error) {
            logRequest({
                protocol: "websocket",
                ip: clientIp,
                purpose: getMessageType(data.toString()),
                outcome: "rejected",
                durationMs: Date.now() - startedAt,
            });
            send(socket, {
                type: "ERROR",
                requestId: getRequestId(data.toString()),
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });

    socket.on("close", (code) => {
        logRequest({
            protocol: "websocket",
            ip: clientIp,
            purpose: "DISCONNECT /ws",
            outcome: String(code),
        });
    });
});

async function handleMessage(
    socket: WebSocket,
    message: ClientMessage,
): Promise<void> {
    switch (message.type) {
        case "GET_STATE":
            send(socket, { type: "STATE_SNAPSHOT", state: engine.getState() });
            break;
        case "START_SYSTEM":
            accept(socket, message.requestId);
            await startSystemWithProgress();
            break;
        case "TRAIN_ENTER":
            engine.registerTrainEntry(message.sectionName, message.axleCount);
            accept(socket, message.requestId);
            break;
        case "TRAIN_EXIT":
            engine.registerTrainExit(message.sectionName, message.axleCount);
            accept(socket, message.requestId);
            break;
        case "RUN_ROUTE":
            if (activeRoute) {
                throw new Error(`Route ${activeRoute} is already running`);
            }
            if (
                STATION_ROUTES[message.route].some((sectionName) =>
                    engine.isSectionResetting(sectionName),
                )
            ) {
                throw new Error(
                    `Route ${message.route} contains a section that is resetting`,
                );
            }

            activeRoute = message.route;
            accept(socket, message.requestId);
            void runRoute(
                message.route,
                message.axleCount,
                message.axlePulseMs ?? 120,
                message.sectionPauseMs ?? 450,
            ).finally(() => {
                activeRoute = null;
            });
            break;
        case "RESET_SECTION": {
            if (activeSectionName === message.sectionName) {
                throw new Error(
                    `${message.sectionName} cannot reset until the train has cleared it`,
                );
            }

            const resetPromise = engine.resetRail(
                message.sectionName,
                message.railId,
            );
            accept(socket, message.requestId);
            await resetPromise;
            break;
        }
        case "FAIL_RAIL":
            if (activeRoute && activeSectionName !== message.sectionName) {
                throw new Error(
                    `During route ${activeRoute}, only active section ${activeSectionName} can be failed`,
                );
            }

            engine.failRail(message.sectionName, message.railId);
            accept(socket, message.requestId);
            break;
    }
}

async function runRoute(
    route: StationRoute,
    axleCount: number,
    axlePulseMs: number,
    sectionPauseMs: number,
): Promise<void> {
    validateDelay(axlePulseMs, "Axle pulse");
    validateDelay(sectionPauseMs, "Section pause");
    const sections = STATION_ROUTES[route];

    try {
        for (const [index, sectionName] of sections.entries()) {
            activeSectionName = sectionName;
            try {
                await moveThroughSection(
                    route,
                    sectionName,
                    index,
                    sections.length,
                    axleCount,
                    axlePulseMs,
                    sectionPauseMs,
                );
            } finally {
                activeSectionName = null;
            }
        }

        broadcast({ type: "ROUTE_COMPLETED", route });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : `Route ${route} failed`;
        broadcast({
            type: "ROUTE_FAILED",
            route,
            message,
        });
        broadcast({ type: "ERROR", message });
    } finally {
        activeSectionName = null;
    }
}

async function moveThroughSection(
    route: StationRoute,
    sectionName: string,
    sectionIndex: number,
    totalSections: number,
    axleCount: number,
    axlePulseMs: number,
    sectionPauseMs: number,
): Promise<void> {
    const entryDuration = Math.max(axlePulseMs * (axleCount - 1), 1);
    const exitStart = entryDuration + sectionPauseMs;
    const totalDuration = exitStart + entryDuration;
    const frameMs = 40;
    const startedAt = Date.now();
    let enteredAxles = 0;
    let exitedAxles = 0;

    while (true) {
        const elapsed = Math.min(Date.now() - startedAt, totalDuration);

        while (
            enteredAxles < axleCount &&
            elapsed >= enteredAxles * axlePulseMs
        ) {
            engine.registerTrainEntryPulse(sectionName);
            enteredAxles += 1;
        }

        while (
            exitedAxles < axleCount &&
            elapsed >= exitStart + exitedAxles * axlePulseMs
        ) {
            engine.registerTrainExit(sectionName, 1);
            exitedAxles += 1;
        }

        const phase =
            enteredAxles < axleCount
                ? "ENTERING"
                : exitedAxles > 0
                  ? "EXITING"
                  : "TRAVERSING";

        broadcastRouteProgress(
            route,
            sectionName,
            sectionIndex,
            totalSections,
            phase,
            phase === "EXITING" ? exitedAxles : enteredAxles,
            axleCount,
            elapsed / totalDuration,
        );

        if (elapsed >= totalDuration) {
            break;
        }

        await delay(frameMs);
    }
}

async function startSystemWithProgress(): Promise<void> {
    const startPromise = engine.startSystem();

    for (const remainingMs of [3_000, 2_000, 1_000]) {
        broadcast({ type: "SYSTEM_CHARGE_PROGRESS", remainingMs });
        await delay(1_000);
    }

    await startPromise;
    broadcast({ type: "SYSTEM_CHARGE_PROGRESS", remainingMs: 0 });
}

function broadcastRouteProgress(
    route: StationRoute,
    sectionName: string,
    sectionIndex: number,
    totalSections: number,
    phase: "ENTERING" | "TRAVERSING" | "EXITING",
    axleNumber: number,
    axleCount: number,
    movementProgress: number,
): void {
    broadcast({
        type: "ROUTE_PROGRESS",
        route,
        sectionName,
        sectionIndex,
        totalSections,
        phase,
        axleNumber,
        axleCount,
        movementProgress,
    });
}

function accept(socket: WebSocket, requestId: string): void {
    send(socket, { type: "COMMAND_ACCEPTED", requestId });
}

function parseClientMessage(value: string): ClientMessage {
    const parsed: unknown = JSON.parse(value);

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
        throw new Error("Invalid WebSocket message");
    }

    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) {
        throw new Error("requestId is required");
    }

    switch (parsed.type) {
        case "START_SYSTEM":
        case "GET_STATE":
            return parsed as ClientMessage;
        case "TRAIN_ENTER":
        case "TRAIN_EXIT":
            requireSectionAndAxles(parsed);
            return parsed as ClientMessage;
        case "RESET_SECTION":
        case "FAIL_RAIL":
            requireSectionName(parsed);
            requireRailId(parsed);
            return parsed as ClientMessage;
        case "RUN_ROUTE":
            if (
                parsed.route !== "MAIN" &&
                parsed.route !== "UPPER_LOOP" &&
                parsed.route !== "LOWER_LOOP"
            ) {
                throw new Error("Unknown station route");
            }
            requireAxleCount(parsed.axleCount);
            optionalDelay(parsed.axlePulseMs, "axlePulseMs");
            optionalDelay(parsed.sectionPauseMs, "sectionPauseMs");
            return parsed as ClientMessage;
        default:
            throw new Error(`Unsupported command "${parsed.type}"`);
    }
}

function requireSectionAndAxles(value: Record<string, unknown>): void {
    requireSectionName(value);
    requireAxleCount(value.axleCount);
}

function requireSectionName(value: Record<string, unknown>): void {
    if (
        typeof value.sectionName !== "string" ||
        !/^(?:[1-9]|1[01])T$/.test(value.sectionName)
    ) {
        throw new Error("sectionName must be between 1T and 11T");
    }
}

function requireRailId(value: Record<string, unknown>): void {
    if (value.railId !== "A" && value.railId !== "B") {
        throw new Error("railId must be A or B");
    }
}

function requireAxleCount(value: unknown): void {
    if (
        !Number.isInteger(value) ||
        Number(value) <= 0 ||
        Number(value) > MAX_AXLE_COUNT
    ) {
        throw new Error(
            `axleCount must be an integer between 1 and ${MAX_AXLE_COUNT}`,
        );
    }
}

function optionalDelay(value: unknown, name: string): void {
    if (
        value !== undefined &&
        (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 10_000)
    ) {
        throw new Error(`${name} must be between 1 and 10000 milliseconds`);
    }
}

function validateDelay(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
        throw new Error(`${name} must be between 1 and 10000 milliseconds`);
    }
}

function getRequestId(value: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) && typeof parsed.requestId === "string"
            ? parsed.requestId
            : undefined;
    } catch {
        return undefined;
    }
}

function getMessageType(value: string): string {
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) && typeof parsed.type === "string"
            ? parsed.type
            : "UNKNOWN_MESSAGE";
    } catch {
        return "INVALID_JSON";
    }
}

function getMessageLogMetadata(
    message: ClientMessage,
): Record<string, string | number> | undefined {
    switch (message.type) {
        case "GET_STATE":
        case "START_SYSTEM":
            return undefined;
        case "TRAIN_ENTER":
        case "TRAIN_EXIT":
        case "RESET_SECTION":
        case "FAIL_RAIL":
            return {
                section: message.sectionName,
                ...("railId" in message ? { rail: message.railId } : {}),
                ...("axleCount" in message
                    ? { axleCount: message.axleCount }
                    : {}),
            };
        case "RUN_ROUTE":
            return {
                route: message.route,
                axleCount: message.axleCount,
            };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Station simulator listening on http://localhost:${PORT}`);
});
